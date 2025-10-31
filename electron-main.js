import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { getLatestUpdate, loadSerialNumbers, processSerials, loadConnectionFile, fetchToken, checkAppSecret, exportData } from "./core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.disableHardwareAcceleration();
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// === IPC HANDLERS ===
ipcMain.handle("load-csv-serialnumbers", async (event, column) => {
  const { filePaths } = await dialog.showOpenDialog({ properties: ["openFile"] });
  if (!filePaths?.length) return { data: [] };
  const file = filePaths[0];
  const data = await loadSerialNumbers(file, column);
  return { filePath: file, filename: path.basename(file), data };
});

ipcMain.handle("process-serials", async (event, args) => {
  const { serialNumbers, connectInfo, dryRun } = args;
  return await processSerials(serialNumbers, connectInfo, dryRun, (msg) => event.sender.send("logging", msg));
});

ipcMain.handle("save-exported-file", async (event, { defaultFileName, data }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: "Save CSV file",
    defaultPath: defaultFileName,
    filters: [{ name: "CSV Files", extensions: ["csv"] }],
  });

  if (!filePath || canceled) return { canceled: true };

  exportData(filePath, data); // <-- write the CSV here
  return { canceled: false, filePath };
});

ipcMain.handle("load-connection-file", async () => {
  return await loadConnectionFile();
});
ipcMain.handle("fetch-token", async (event, connectInfo) => {
  const { tenant_name_or_id, client_id, client_secret } = connectInfo;

  if (!tenant_name_or_id || !client_id || !client_secret) {
    throw new Error("Tenant ID, Client ID, or Client Secret missing");
  }

  return await fetchToken(tenant_name_or_id, client_id, client_secret);
});
ipcMain.handle("get-latest-update", async () => {
  return await getLatestUpdate();
});
ipcMain.handle("check-app-secret", async (event, connectInfo) => {
  return await checkAppSecret(connectInfo);
});
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("exit-app", () => app.quit());
