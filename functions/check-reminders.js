// يشتغل من GitHub Actions (مُشغَّل بواسطة cron-job.org) كل دقيقة أو دقيقتين.
// بيقرأ من Firestore جدول كل مستخدم، ويحسب "هل الميعاد فات من دلوقتي بمدة قريبة؟"
// بتوقيت المستخدم نفسه (مش بتوقيت السيرفر)، ولو أيوه، يبعت إشعار Push حقيقي.
//
// مهم: السيرفر ده مش بيعرف اسم الدواء أو تفاصيله - بيبعت بس النص المشفّر (ciphertext)
// اللي المستخدم رفّعه، والتطبيق على جهاز المريض هو الوحيد اللي عنده مفتاح فك التشفير.

const admin = require('firebase-admin');
const webpush = require('web-push');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:admin@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

function currentMinutesInZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const hh = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const mm = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    return (hh % 24) * 60 + mm;
  } catch (e) {
    const now = new Date();
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}
function timeStrToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
const GRACE_MINUTES = 6;

async function run() {
  const usersSnap = await db.collection('users').get();
  console.log(`Checking ${usersSnap.size} user(s)...`);

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    const timeZone = user.timeZone || 'Africa/Cairo';
    const subscription = user.pushSubscription;
    const nowMinutes = currentMinutesInZone(timeZone);
    const todayKey = new Date().toISOString().slice(0, 10);
    const reminders = user.reminders || [];
    console.log(`  User ${userDoc.id}: timeZone=${timeZone}, nowMinutes=${nowMinutes}, hasSubscription=${!!subscription}, reminders=${reminders.length}`);
    if (!subscription) continue;

    for (const reminder of reminders) {
      const times = reminder.times || [];
      for (const t of times) {
        let targetTime = null;
        if (t.type === 'fixed') targetTime = t.value;
        else if (t.type === 'meal') targetTime = (user.meals || {})[t.value];
        const targetMinutes = timeStrToMinutes(targetTime);
        if (targetMinutes === null) continue;
        const diff = nowMinutes - targetMinutes;
        console.log(`      checking time ${t.type}:${t.value} -> target=${targetTime} (${targetMinutes}m) vs now=${nowMinutes}m, diff=${diff}`);
        const isDue = diff >= 0 && diff <= GRACE_MINUTES;
        if (!isDue) continue;

        const alertKey = `${reminder.id}_${t.type}_${t.value}_${todayKey}`;
        const lastAlertRef = db.collection('sentAlerts').doc(`${userDoc.id}_${alertKey}`);
        const already = await lastAlertRef.get();
        if (already.exists) continue;

        const payload = JSON.stringify({
          title: reminder.encryptedTitle,
          body: reminder.encryptedBody || '',
          encrypted: true,
        });

        try {
          await webpush.sendNotification(subscription, payload);
          console.log(`Sent reminder to user ${userDoc.id} for ${reminder.id}`);
        } catch (err) {
          console.error(`Failed to send to ${userDoc.id}:`, err.message);
        }

        await lastAlertRef.set({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
