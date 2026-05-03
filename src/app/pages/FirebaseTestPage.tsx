import { useState } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Button } from '../components/ui/button';
import { Loader2, ExternalLink } from 'lucide-react';

export function FirebaseTestPage() {
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (message: string) => {
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  const testFirebase = async () => {
    setStatus('testing');
    setLogs([]);
    
    try {
      addLog('Starting Firebase connection test...');
      
      // Test 1: Firebase initialization
      addLog('✓ Firebase SDK initialized');
      addLog(`✓ Project ID: exam-forge-1-40ba7`);
      
      // Test 2: Write operation
      addLog('→ Testing WRITE operation...');
      const testRef = collection(db, 'firebaseConnectionTest');
      const docRef = await addDoc(testRef, {
        timestamp: new Date().toISOString(),
        testData: 'STRATUM Firebase Test',
        random: Math.random()
      });
      addLog(`✓ WRITE successful - Document ID: ${docRef.id}`);
      
      // Test 3: Read operation
      addLog('→ Testing READ operation...');
      const snapshot = await getDocs(testRef);
      addLog(`✓ READ successful - Found ${snapshot.size} document(s)`);
      
      // Test 4: Delete operation
      addLog('→ Testing DELETE operation...');
      await deleteDoc(doc(db, 'firebaseConnectionTest', docRef.id));
      addLog('✓ DELETE successful - Test document removed');
      
      addLog('');
      addLog('🎉 ALL TESTS PASSED - Firebase is fully operational!');
      setStatus('success');
      
    } catch (error: any) {
      addLog('');
      addLog(`❌ ERROR: ${error.message}`);
      addLog(`Error Code: ${error.code || 'unknown'}`);
      
      if (error.code === 'permission-denied') {
        addLog('');
        addLog('⚠️  SOLUTION: Update Firestore Security Rules');
        addLog('Go to: Firebase Console → Firestore Database → Rules');
        addLog('');
        addLog('Replace with:');
        addLog('─────────────────────────────────────────');
        addLog("rules_version = '2';");
        addLog('service cloud.firestore {');
        addLog('  match /databases/{database}/documents {');
        addLog('    match /{document=**} {');
        addLog('      allow read, write: if true;');
        addLog('    }');
        addLog('  }');
        addLog('}');
        addLog('─────────────────────────────────────────');
      } else if (error.message?.includes('Missing or insufficient permissions') || 
                 error.message?.includes('not exist') ||
                 error.code === 'failed-precondition') {
        addLog('');
        addLog('⚠️  FIRESTORE DATABASE NOT CREATED');
        addLog('You need to create Firestore database first!');
        addLog('Follow the setup instructions below ⬇️');
      }
      
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F7F6F3' }}>
      <div className="w-full max-w-3xl space-y-6">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-medium" style={{ color: '#0C0C0B' }}>
            Firebase Connection Test
          </h1>
          <p className="text-sm" style={{ color: '#0C0C0B', opacity: 0.6 }}>
            STRATUM Platform - Firebase Verification
          </p>
        </div>

        {/* Setup Instructions */}
        <div className="bg-amber-50 border-2 border-amber-300 p-6 rounded-lg">
          <h2 className="font-medium mb-3 text-amber-900 flex items-center gap-2">
            ⚠️ First Time Setup Required
          </h2>
          <div className="space-y-4 text-sm text-amber-900">
            
            {/* IMPORTANT WARNING */}
            <div className="bg-red-100 border-2 border-red-400 p-4 rounded">
              <p className="font-bold text-red-900 mb-2">🚨 IMPORTANT: Use Cloud Firestore (NOT Realtime Database)</p>
              <p className="text-red-800">
                Firebase has TWO database products. You need <strong>Cloud Firestore</strong>, not "Realtime Database".
              </p>
            </div>

            <div>
              <p className="font-medium mb-2">Step 1: Open Firebase Console</p>
              <a 
                href="https://console.firebase.google.com/project/exam-forge-1-40ba7/firestore"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 transition-colors"
              >
                Open Cloud Firestore Console
                <ExternalLink className="w-4 h-4" />
              </a>
              <p className="text-xs mt-2 opacity-75">
                ✓ Look for "Cloud Firestore" in the left sidebar (NOT "Realtime Database")
              </p>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Step 2: Create Cloud Firestore Database</p>
              <ol className="list-decimal list-inside space-y-1 pl-2">
                <li>Click "Create Database" button (should see "Cloud Firestore" at top)</li>
                <li>Choose location: <strong>us-central (Iowa)</strong> or closest to you</li>
                <li>Select "Start in <strong>test mode</strong>" (important!)</li>
                <li>Click "Enable"</li>
                <li>Wait for database creation (takes ~30 seconds)</li>
              </ol>
              <p className="text-xs mt-2 bg-white p-2 rounded border border-amber-300">
                💡 <strong>How to verify:</strong> After creation, you should see "Cloud Firestore" at the top of the page with tabs: Data, Rules, Indexes, Usage
              </p>
            </div>

            <div className="space-y-2">
              <p className="font-medium">Step 3: Verify Security Rules</p>
              <p>Click the "Rules" tab. You should see rules that look like this:</p>
              <div className="bg-white p-3 rounded border border-amber-300 font-mono text-xs overflow-x-auto">
                <pre className="text-green-700">{`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time < timestamp.date(2025, 1, 20);
    }
  }
}`}</pre>
              </div>
              <p className="text-xs opacity-75 mt-2">
                ⚠️ If you see JSON format like <code className="bg-white px-1 rounded">{`{ "rules": { ".read": false } }`}</code> - 
                that's <strong>Realtime Database</strong>, not Firestore! Go back to step 1.
              </p>
              <p className="mt-2">For testing, you can update to allow all access:</p>
              <div className="bg-white p-3 rounded border border-amber-300 font-mono text-xs overflow-x-auto">
                <pre>{`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`}</pre>
              </div>
            </div>

            <div>
              <p className="font-medium">Step 4: Run Test</p>
              <p>Once setup is complete, click "Run Firebase Test" button below</p>
            </div>
          </div>
        </div>

        {/* Test Button */}
        <div className="flex justify-center">
          <Button
            onClick={testFirebase}
            disabled={status === 'testing'}
            size="lg"
            className="min-w-[200px]"
          >
            {status === 'testing' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {status === 'testing' ? 'Testing...' : 'Run Firebase Test'}
          </Button>
        </div>

        {/* Status Card */}
        {status !== 'idle' && (
          <div className={`p-6 rounded-lg border-2 ${
            status === 'success' ? 'bg-green-50 border-green-300' :
            status === 'error' ? 'bg-red-50 border-red-300' :
            'bg-blue-50 border-blue-300'
          }`}>
            <h2 className="font-medium mb-4" style={{ color: '#0C0C0B' }}>
              {status === 'success' && '✅ Success'}
              {status === 'error' && '❌ Failed'}
              {status === 'testing' && '⏳ Testing...'}
            </h2>

            {/* Logs */}
            <div className="bg-white p-4 rounded border font-mono text-xs space-y-1 max-h-96 overflow-y-auto">
              {logs.map((log, idx) => (
                <div
                  key={idx}
                  className={
                    log.includes('✓') ? 'text-green-700' :
                    log.includes('❌') || log.includes('ERROR') ? 'text-red-700' :
                    log.includes('→') ? 'text-blue-700' :
                    log.includes('⚠️') || log.includes('SOLUTION') ? 'text-amber-700 font-bold' :
                    log.includes('🎉') ? 'text-green-700 font-bold' :
                    'text-gray-700'
                  }
                >
                  {log}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Info */}
        <div className="text-center text-xs" style={{ color: '#0C0C0B', opacity: 0.4 }}>
          <p>This test will create a temporary document, read it, then delete it.</p>
          <p className="mt-1">No permanent data will be stored in your Firebase database.</p>
        </div>

        {/* Firebase Config */}
        <div className="bg-white p-4 rounded border text-xs">
          <p className="font-medium mb-2" style={{ color: '#0C0C0B' }}>Current Configuration:</p>
          <div className="font-mono space-y-1" style={{ color: '#0C0C0B', opacity: 0.6 }}>
            <div>Project ID: exam-forge-1-40ba7</div>
            <div>Auth Domain: exam-forge-1-40ba7.firebaseapp.com</div>
            <div>Storage: exam-forge-1-40ba7.firebasestorage.app</div>
          </div>
        </div>

      </div>
    </div>
  );
}