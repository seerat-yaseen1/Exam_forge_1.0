/**
 * Web Owner Initialization
 * 
 * This script creates the default Web Owner account in Firebase if it doesn't exist.
 * Run this once after Firebase migration to set up the initial admin account.
 */

import { getWebOwnerByEmail, setWebOwner } from './firebaseService';

const DEFAULT_WEB_OWNER = {
  email: 'owner@platform.com',
  name: 'Platform Owner',
  password: 'admin123', // CHANGE THIS IMMEDIATELY after first login
};

export async function initializeWebOwner(): Promise<{
  success: boolean;
  message: string;
  credentials?: typeof DEFAULT_WEB_OWNER;
}> {
  try {
    // Check if Web Owner already exists
    const existing = await getWebOwnerByEmail(DEFAULT_WEB_OWNER.email);
    
    if (existing) {
      return {
        success: true,
        message: 'Web Owner account already exists.',
      };
    }

    // Create the Web Owner account
    await setWebOwner(DEFAULT_WEB_OWNER.email, {
      email: DEFAULT_WEB_OWNER.email,
      name: DEFAULT_WEB_OWNER.name,
      password: DEFAULT_WEB_OWNER.password,
    });

    console.log('✅ Web Owner account created successfully!');
    console.log('Email:', DEFAULT_WEB_OWNER.email);
    console.log('Password:', DEFAULT_WEB_OWNER.password);
    console.log('⚠️  IMPORTANT: Change this password immediately after first login!');

    return {
      success: true,
      message: 'Web Owner account created successfully!',
      credentials: DEFAULT_WEB_OWNER,
    };
  } catch (error: any) {
    console.error('❌ Failed to initialize Web Owner:', error);
    return {
      success: false,
      message: error.message || 'Failed to initialize Web Owner account.',
    };
  }
}
