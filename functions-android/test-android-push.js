// بيبعت "رسالة بيانات بس" (Data-only) لجهاز أندرويد عن طريق رمزه (FCM token).
// الفرق المهم: ده مش "إشعار جاهز" (Notification payload) - ده بيانات خام بس،
// فالنظام مابيعرضهاش تلقائيًا، وده بيجبر تطبيقنا (MyFirebaseMessagingService)
// إنه يشتغل هو نفسه ويبني الإشعار بالصوت المخصص، حتى والتطبيق مقفول تمامًا.

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const DEVICE_TOKEN = process.env.TEST_DEVICE_TOKEN;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  if (!DEVICE_TOKEN) {
    console.error('محتاجين رمز الجهاز (TEST_DEVICE_TOKEN) - مش موجود.');
    process.exit(1);
  }

  const message = {
    token: DEVICE_TOKEN,
    data: {
      title: 'تذكير الدواء',
      body: 'قوم خد دوايك دلوقتي',
    },
    android: {
      priority: 'high',
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('اتبعتت بنجاح:', response);
  } catch (err) {
    console.error('فشل الإرسال:', err.message);
    process.exit(1);
  }
}

run();
