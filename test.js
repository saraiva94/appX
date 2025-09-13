const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  });

  win.loadFile('test.html');
  win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  
  // Envia um teste a cada 2 segundos
  let id = 0;
  setInterval(() => {
    if (!win) return;
    try {
      const testData = { id: `teste-${++id}`, b64: 'TEST'.repeat(10) };
      console.log('Main: enviando:', testData.id);
      win.webContents.send('shot:image', testData);
    } catch (e) {
      console.error('Main: erro ao enviar:', e);
    }
  }, 2000);
});

ipcMain.on('shot:ack', (_e, info) => {
  console.log('Main: recebeu ack:', info);
});

ipcMain.on('status', (_e, msg) => {
  console.log('Main: status:', msg);
});

app.on('window-all-closed', () => app.quit());