import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Firebase configuration
// Replace these with your actual Firebase project credentials from Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyAGT8IAn2YWEJNHiZVwuGmy4JFSdh2km5E",
  authDomain: "exam-forge-1-40ba7.firebaseapp.com",
  projectId: "exam-forge-1-40ba7",
  storageBucket: "exam-forge-1-40ba7.firebasestorage.app",
  messagingSenderId: "530247377004",
  appId: "1:530247377004:web:ec88e6ebadcb61026d7849"
};

// Initialize Firebase (only if not already initialized)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore
export const db = getFirestore(app);

// Initialize Firebase Storage
export const storage = getStorage(app);

export default app;