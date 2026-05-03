import { useState } from 'react';
import { motion } from 'motion/react';
import { Database, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  firestoreGetAll,
  getAllInstitutes,
  type Faculty,
  type Student,
  type WebOwner,
  type Institute,
  type FacultyCredentials,
  type StudentCredentials,
  type InstituteCredentials,
} from '../../lib/firebaseService';

export function FirebaseDebugPage() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    webowners: WebOwner[];
    institutes: Institute[];
    instituteCredentials: InstituteCredentials[];
    faculty: Faculty[];
    facultyCredentials: FacultyCredentials[];
    students: Student[];
    studentCredentials: StudentCredentials[];
  } | null>(null);

  const loadAllData = async () => {
    setLoading(true);
    try {
      const [
        webowners,
        institutes,
        instituteCredentials,
        faculty,
        facultyCredentials,
        students,
        studentCredentials,
      ] = await Promise.all([
        firestoreGetAll<WebOwner>('webowners'),
        firestoreGetAll<Institute>('institutes'),
        firestoreGetAll<InstituteCredentials>('instituteCredentials'),
        firestoreGetAll<Faculty>('faculty'),
        firestoreGetAll<FacultyCredentials>('facultyCredentials'),
        firestoreGetAll<Student>('students'),
        firestoreGetAll<StudentCredentials>('studentCredentials'),
      ]);

      setData({
        webowners,
        institutes,
        instituteCredentials,
        faculty,
        facultyCredentials,
        students,
        studentCredentials,
      });

      console.log('📊 FIREBASE DATA LOADED:', {
        webowners,
        institutes,
        instituteCredentials,
        faculty,
        facultyCredentials,
        students,
        studentCredentials,
      });
    } catch (error) {
      console.error('❌ Error loading Firebase data:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: '#F7F6F3', padding: '2rem' }}>
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Database size={24} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
            <div>
              <h1 className="text-2xl font-medium" style={{ color: '#0C0C0B' }}>
                Firebase Debug Console
              </h1>
              <p className="text-sm mt-1" style={{ color: '#9A9891' }}>
                View all Firestore collections and documents
              </p>
            </div>
          </div>
          <button
            onClick={loadAllData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm transition-opacity"
            style={{
              background: loading ? '#C8C7C2' : '#0C0C0B',
              color: '#FFFFFF',
              borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            <RefreshCw size={14} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading...' : 'Load All Data'}
          </button>
        </div>

        {/* Instructions */}
        <div
          className="flex items-start gap-3 px-4 py-3 mb-6"
          style={{ background: '#E8F4FF', border: '1px solid #B3D9FF', borderRadius: 4 }}
        >
          <AlertCircle size={16} strokeWidth={1.5} style={{ color: '#0066CC', marginTop: 2 }} />
          <div className="text-sm" style={{ color: '#0066CC' }}>
            <p className="font-medium mb-1">How to use:</p>
            <ol className="list-decimal list-inside space-y-1 text-xs">
              <li>Click "Load All Data" to fetch all Firestore collections</li>
              <li>Open your browser console (F12) to see detailed logs</li>
              <li>Each collection shows its document count</li>
              <li>Click on any collection below to expand and see documents</li>
            </ol>
          </div>
        </div>

        {/* Data Display */}
        {data && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {/* Web Owners */}
            <CollectionCard
              title="Web Owners"
              collection="webowners"
              count={data.webowners.length}
              data={data.webowners}
            />

            {/* Institutes */}
            <CollectionCard
              title="Institutes"
              collection="institutes"
              count={data.institutes.length}
              data={data.institutes}
            />

            {/* Institute Credentials */}
            <CollectionCard
              title="Institute Credentials"
              collection="instituteCredentials"
              count={data.instituteCredentials.length}
              data={data.instituteCredentials}
            />

            {/* Faculty */}
            <CollectionCard
              title="Faculty"
              collection="faculty"
              count={data.faculty.length}
              data={data.faculty}
            />

            {/* Faculty Credentials */}
            <CollectionCard
              title="Faculty Credentials"
              collection="facultyCredentials"
              count={data.facultyCredentials.length}
              data={data.facultyCredentials}
            />

            {/* Students */}
            <CollectionCard
              title="Students"
              collection="students"
              count={data.students.length}
              data={data.students}
            />

            {/* Student Credentials */}
            <CollectionCard
              title="Student Credentials"
              collection="studentCredentials"
              count={data.studentCredentials.length}
              data={data.studentCredentials}
            />
          </motion.div>
        )}

        {!data && !loading && (
          <div className="text-center py-12" style={{ color: '#9A9891' }}>
            Click "Load All Data" to view Firebase collections
          </div>
        )}
      </div>
    </div>
  );
}

function CollectionCard({
  title,
  collection,
  count,
  data,
}: {
  title: string;
  collection: string;
  count: number;
  data: any[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="overflow-hidden"
      style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 4 }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-50"
        style={{ borderBottom: expanded ? '1px solid #E3E1DB' : 'none' }}
      >
        <div className="flex items-center gap-3">
          <Database size={16} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
          <div>
            <h3 className="text-base font-medium" style={{ color: '#0C0C0B' }}>
              {title}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
              Collection: <code className="px-1.5 py-0.5" style={{ background: '#F7F6F3', borderRadius: 2 }}>{collection}</code>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs"
            style={{
              background: count > 0 ? '#F0F7F2' : '#FDF5F5',
              color: count > 0 ? '#2A6B3A' : '#9A9891',
              borderRadius: 12,
            }}
          >
            {count > 0 ? (
              <CheckCircle2 size={12} strokeWidth={2} />
            ) : (
              <AlertCircle size={12} strokeWidth={2} />
            )}
            {count} {count === 1 ? 'document' : 'documents'}
          </div>
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M3 4.5L6 7.5L9 4.5"
                stroke="#9A9891"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.div>
        </div>
      </button>

      {expanded && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="px-5 py-4"
        >
          {count === 0 ? (
            <p className="text-sm text-center py-8" style={{ color: '#9A9891' }}>
              No documents in this collection
            </p>
          ) : (
            <div className="space-y-3">
              {data.map((doc: any, index: number) => (
                <div
                  key={index}
                  className="p-3"
                  style={{ background: '#F7F6F3', borderRadius: 4, border: '1px solid #E3E1DB' }}
                >
                  <pre
                    className="text-xs overflow-x-auto"
                    style={{ color: '#0C0C0B', fontFamily: 'monospace' }}
                  >
                    {JSON.stringify(doc, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
