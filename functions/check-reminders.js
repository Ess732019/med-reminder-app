// يشتغل من GitHub Actions (مُشغَّل بواسطة cron-job.org) كل دقيقة أو دقيقتين.
// بيقرأ من Firestore جدول كل مستخدم، ويحسب "هل الوقت الحالي = ميعاد جرعة؟" بتوقيت
// المستخدم نفسه (مش بتوقيت السيرفر)، ولو أيوه، يبعت إشعار Push حقيقي.
//
// مهم: السيرفر ده مش بيعرف اسم الدواء أو تفاصيله - بيبعت بس النص المشفّر (ciphertext)
// اللي المستخدم رفّعه، والتطبيق على جهاز المريض هو الوحيد اللي عنده مفتاح فك التشفير.

const admin = require('firebase-admin');
const webpush = require('web-push');

// بيانات الدخول والمفاتيح بتيجي من GitHub Secrets (متغيرات بيئة)، مش مكتوبة هنا خالص
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:admin@example.com', // ملاحظة: يفضّل تغييره لإيميل حقيقي بتاعك لاحقًا
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// بيحسب الوقت الحالي "HH:MM" في المنطقة الزمنية بتاعة المستخدم نفسه، بغض النظر
// عن مكان السيرفر
function currentTimeInZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const hh = parts.find((p) => p.type === 'hour').value;
    const mm = parts.find((p) => p.type === 'minute').value;
    return `${hh}:${mm}`;
  } catch (e) {
    // لو المنطقة الزمنية مش معروفة لأي سبب، استخدم UTC كحل احتياطي آمن
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
}

async function run() {
  const usersSnap = await db.collection('users').get();
  console.log(`Checking ${usersSnap.size} user(s)...`);

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    const timeZone = user.timeZone || 'Africa/Cairo';
    const subscription = user.pushSubscription;
    const nowHHMM = currentTimeInZone(timeZone);
    const reminders = user.reminders || [];
    console.log(`  User ${userDoc.id}: timeZone=${timeZone}, localNow=${nowHHMM}, hasSubscription=${!!subscription}, reminders=${reminders.length}`);
    reminders.forEach(r=>{
      const timesStr = (r.times||[]).map(t=> `${t.type}:${t.value}`).join(', ');
      console.log(`    reminder ${r.id}: [${timesStr}]`);
    });
    if (!subscription) continue;

    for (const reminder of reminders) {
      const times = reminder.times || [];
      for (const t of times) {
        let targetTime = null;
        if (t.type === 'fixed') targetTime = t.value;
        else if (t.type === 'meal') targetTime = (user.meals || {})[t.value];
        console.log(`      checking time ${t.type}:${t.value} -> target=${targetTime} vs now=${nowHHMM}`);
        if (!targetTime || targetTime !== nowHHMM) continue;

        // منع تكرار نفس التذكير أكتر من مرة في نفس الدقيقة لو الفحص اتكرر بسرعة
        const alertKey = `${reminder.id}_${t.type}_${t.value}_${nowHHMM}`;
        const lastAlertRef = db.collection('sentAlerts').doc(`${userDoc.id}_${alertKey}`);
        const already = await lastAlertRef.get();
        if (already.exists) continue;

        const payload = JSON.stringify({
          title: reminder.encryptedTitle, // نص مشفّر - السيرفر مش عارف يقرأه
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
