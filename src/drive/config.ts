// Google Drive settings of this build.
//  • VITE_GOOGLE_CLIENT_ID: the OAuth client the owner creates in Google Cloud (not a secret);
//    it can also be pasted in the settings on each device.
//  • VITE_DRIVE_API / VITE_DRIVE_FAKE=1: a local stand-in for Drive (scripts/fake-drive.mjs), to try
//    the app on two "devices" without a Google account.
export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || ''
export const DRIVE_API = (import.meta.env.VITE_DRIVE_API as string | undefined)?.trim() || 'https://www.googleapis.com'
export const DRIVE_FAKE = import.meta.env.VITE_DRIVE_FAKE === '1'
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.appdata']
