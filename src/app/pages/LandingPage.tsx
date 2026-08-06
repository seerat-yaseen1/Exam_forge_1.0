import { motion } from 'motion/react';
import { useAuth } from '../context/AuthContext';

export function LandingPage() {
  const { user } = useAuth();

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ minHeight: 'calc(100vh - 56px)', background: 'var(--ef-canvas)' }}
    >
      {/* Intentionally empty — a system at rest is a system in control */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="flex flex-col items-center gap-2"
      >
        <div
          style={{
            width: 1,
            height: 40,
            background: 'linear-gradient(to bottom, transparent, var(--ef-border-muted))',
            marginBottom: 16,
          }}
        />
        <p
          className="text-xs"
          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.14em' }}
        >
          COMMAND CENTER
        </p>
        <p
          className="text-xs"
          style={{ color: 'var(--ef-border-muted)', letterSpacing: '0.06em' }}
        >
          Modules will appear here
        </p>
        <div
          style={{
            width: 1,
            height: 40,
            background: 'linear-gradient(to top, transparent, var(--ef-border-muted))',
            marginTop: 16,
          }}
        />
      </motion.div>
    </div>
  );
}