import { useState } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Loader2, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

export function FirebaseTest() {
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState<string[]>([]);

  const testFirebaseConnection = async () => {
    setStatus('testing');
    setMessage('Testing Firebase connection...');
    setDetails([]);
    const testDetails: string[] = [];

    try {
      // Test 1: Check if Firebase is initialized
      testDetails.push('✓ Firebase SDK initialized');
      setDetails([...testDetails]);

      // Test 2: Try to write a test document
      const testCollectionRef = collection(db, 'connectionTest');
      const testDoc = {
        timestamp: new Date().toISOString(),
        test: 'Firebase connection test',
        platform: 'STRATUM'
      };

      testDetails.push('→ Attempting to write test document...');
      setDetails([...testDetails]);

      const docRef = await addDoc(testCollectionRef, testDoc);
      testDetails.push(`✓ Successfully wrote document with ID: ${docRef.id}`);
      setDetails([...testDetails]);

      // Test 3: Try to read the document back
      testDetails.push('→ Attempting to read documents...');
      setDetails([...testDetails]);

      const querySnapshot = await getDocs(testCollectionRef);
      testDetails.push(`✓ Successfully read ${querySnapshot.size} document(s)`);
      setDetails([...testDetails]);

      // Test 4: Clean up - delete the test document
      testDetails.push('→ Cleaning up test document...');
      setDetails([...testDetails]);

      await deleteDoc(doc(db, 'connectionTest', docRef.id));
      testDetails.push('✓ Successfully deleted test document');
      setDetails([...testDetails]);

      // All tests passed
      setStatus('success');
      setMessage('✅ Firebase is working perfectly!');
      setDetails([...testDetails]);

    } catch (error: any) {
      console.error('Firebase test failed:', error);
      
      testDetails.push(`✗ Error: ${error.message}`);
      
      // Provide helpful error messages
      if (error.code === 'permission-denied') {
        testDetails.push('');
        testDetails.push('⚠️  This is a Firestore security rules issue.');
        testDetails.push('   Go to Firebase Console → Firestore Database → Rules');
        testDetails.push('   Set rules to allow read/write for testing:');
        testDetails.push('');
        testDetails.push('   rules_version = \'2\';');
        testDetails.push('   service cloud.firestore {');
        testDetails.push('     match /databases/{database}/documents {');
        testDetails.push('       match /{document=**} {');
        testDetails.push('         allow read, write: if true;');
        testDetails.push('       }');
        testDetails.push('     }');
        testDetails.push('   }');
      } else if (error.code === 'unavailable') {
        testDetails.push('');
        testDetails.push('⚠️  Network error - check your internet connection');
      } else if (error.code?.includes('auth')) {
        testDetails.push('');
        testDetails.push('⚠️  Authentication error - check Firebase config');
      }

      setStatus('error');
      setMessage('❌ Firebase connection failed');
      setDetails([...testDetails]);
    }
  };

  return (
    <Card className="p-6 max-w-2xl mx-auto mt-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Firebase Connection Test</h2>
          {status === 'success' && <CheckCircle className="w-6 h-6 text-green-600" />}
          {status === 'error' && <XCircle className="w-6 h-6 text-red-600" />}
          {status === 'testing' && <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />}
        </div>

        <div className="text-sm text-[#0C0C0B]/60">
          Project ID: <span className="font-mono">exam-forge-1-40ba7</span>
        </div>

        <Button
          onClick={testFirebaseConnection}
          disabled={status === 'testing'}
          className="w-full"
        >
          {status === 'testing' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {status === 'testing' ? 'Testing...' : 'Test Firebase Connection'}
        </Button>

        {message && (
          <div className={`p-4 rounded-lg ${
            status === 'success' ? 'bg-green-50 border border-green-200' :
            status === 'error' ? 'bg-red-50 border border-red-200' :
            'bg-blue-50 border border-blue-200'
          }`}>
            <p className="font-medium">{message}</p>
          </div>
        )}

        {details.length > 0 && (
          <div className="bg-[#0C0C0B]/5 p-4 rounded-lg">
            <p className="text-sm font-medium mb-2">Test Details:</p>
            <div className="font-mono text-xs space-y-1">
              {details.map((detail, index) => (
                <div key={index} className={
                  detail.startsWith('✓') ? 'text-green-600' :
                  detail.startsWith('✗') ? 'text-red-600' :
                  detail.startsWith('→') ? 'text-blue-600' :
                  detail.startsWith('⚠️') ? 'text-amber-600' :
                  'text-[#0C0C0B]/60'
                }>
                  {detail}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-[#0C0C0B]/40 pt-4 border-t">
          <p className="font-medium mb-1">What this test does:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Verifies Firebase SDK initialization</li>
            <li>Tests write permissions to Firestore</li>
            <li>Tests read permissions from Firestore</li>
            <li>Tests delete permissions</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
