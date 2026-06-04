import { app, ipcMain } from 'electron';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const getPrefsFile = () => {
  const userDataPath = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('userData');
  return path.join(userDataPath, 'sculptio_user_data.json');
};

export function initializeStorageHandlers() {
  
  ipcMain.handle('userData-read', async () => {
    try {
      const prefsFile = getPrefsFile();
      if (existsSync(prefsFile)) {
        const rawData = await readFile(prefsFile, 'utf-8');
        return JSON.parse(rawData);
      }
      return {};
    } catch (error) {
      console.error("Failed to read preferences:", error);
      return {};
    }
  });

  ipcMain.handle('userData-write', async (_event, data: Record<string, any>) => {
    try {
      const prefsFile = getPrefsFile();
      const jsonString = JSON.stringify(data, null, 2);
      await writeFile(prefsFile, jsonString, 'utf-8');
      return true;
    } catch (error) {
      console.error("Failed to write preferences:", error);
      return false;
    }
  });
}