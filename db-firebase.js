const { initializeApp, getApps } = require("firebase/app");
const {
  getFirestore,
  doc,
  setDoc,
  collection,
  addDoc,
  serverTimestamp,
} = require("firebase/firestore");

let firestore;
let firestoreInitError;
const FIRESTORE_WRITE_TIMEOUT_MS = 2500;

function getEnvValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}

function getFirebaseConfig() {
  const config = {
    apiKey: getEnvValue("FIREBASE_API_KEY", "APIKEY"),
    authDomain: getEnvValue("FIREBASE_AUTH_DOMAIN", "AUTHDOMAIN"),
    projectId: getEnvValue("FIREBASE_PROJECT_ID", "PROJECTID"),
    storageBucket: getEnvValue("FIREBASE_STORAGE_BUCKET", "STORAGEBUCKET"),
    messagingSenderId: getEnvValue(
      "FIREBASE_MESSAGING_SENDER_ID",
      "MESSAGINGSENDERID",
    ),
    appId: getEnvValue("FIREBASE_APP_ID", "APPID"),
    measurementId: getEnvValue("FIREBASE_MEASUREMENT_ID", "MEASUREMENTID"),
  };

  const requiredKeys = ["apiKey", "authDomain", "projectId", "appId"];
  const missing = requiredKeys.filter((key) => !config[key]);

  return {
    config,
    missing,
  };
}

function initializeFirestore() {
  if (firestore || firestoreInitError) {
    return;
  }

  const { config, missing } = getFirebaseConfig();
  if (missing.length > 0) {
    firestoreInitError = `Missing Firebase env vars: ${missing.join(", ")}.`;
    return;
  }

  try {
    const app = getApps().length > 0 ? getApps()[0] : initializeApp(config);
    firestore = getFirestore(app);
  } catch (error) {
    firestoreInitError = `Failed to initialize Firestore: ${error.message}`;
  }
}

initializeFirestore();

function isFirestoreReady() {
  return Boolean(firestore);
}

function getFirestoreStatus() {
  return {
    ready: Boolean(firestore),
    error: firestoreInitError || null,
  };
}

async function saveChatExchange({
  sessionId,
  userMessage,
  assistantMessage,
  sourceLinks,
  fileSearchStoreName,
}) {
  if (!firestore) {
    return {
      saved: false,
      reason: firestoreInitError || "Firestore is not initialized.",
    };
  }

  try {
    const withTimeout = (promise, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`${label} timed out after ${FIRESTORE_WRITE_TIMEOUT_MS}ms.`));
          }, FIRESTORE_WRITE_TIMEOUT_MS);
        }),
      ]);

    const sessionRef = doc(firestore, "chatSessions", sessionId);

    await withTimeout(
      setDoc(
        sessionRef,
        {
          sessionId,
          fileSearchStoreName: fileSearchStoreName || null,
          sourceLinks: sourceLinks || [],
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      ),
      "Saving chat session",
    );

    await withTimeout(
      addDoc(collection(sessionRef, "messages"), {
        role: "user",
        content: userMessage,
        createdAt: serverTimestamp(),
      }),
      "Saving user message",
    );

    await withTimeout(
      addDoc(collection(sessionRef, "messages"), {
        role: "assistant",
        content: assistantMessage,
        createdAt: serverTimestamp(),
      }),
      "Saving assistant message",
    );

    return { saved: true };
  } catch (error) {
    return {
      saved: false,
      reason: error.message,
    };
  }
}

module.exports = {
  isFirestoreReady,
  getFirestoreStatus,
  saveChatExchange,
};
