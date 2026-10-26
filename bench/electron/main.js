// Hosts the exact same built frontend as the Tauri app (../../dist) so size,
// memory and startup can be compared like for like. `invoke` calls fail here
// and the frontend falls back to default stats, which doesn't affect the
// measurements.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 820, title: 'Snake 2.0 - Electron' });
  win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
