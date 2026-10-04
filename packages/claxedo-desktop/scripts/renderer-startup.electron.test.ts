import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { build } from "vite"
import solid from "vite-plugin-solid"

// Exercise the real renderer entry in Electron. Only the preload reply and the
// already-booted App are substituted: a failed startup must never reach App.
test("renderer paints while starting, exposes a rejected lease, and mounts App only after readiness", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "claxedo-renderer-startup-"))
  const packageRoot = path.resolve(import.meta.dir, "..")
  try {
    writeFileSync(path.join(root, "app.js"), `export function App(props) {
      const node = document.createElement('p'); node.id = 'ready-app';
      node.textContent = props.serverUrl; return node;
    }`)
    writeFileSync(path.join(root, "styles.js"), "export {}")
    await build({
      configFile: false,
      root: packageRoot,
      publicDir: false,
      logLevel: "silent",
      plugins: [solid()],
      resolve: { alias: [
        { find: "#app/styles", replacement: path.join(root, "styles.js") },
        { find: "#app", replacement: path.join(root, "app.js") },
      ] },
      build: {
        outDir: path.join(root, "renderer"),
        lib: { entry: path.join(packageRoot, "src/renderer/main.tsx"), formats: ["es"], fileName: () => "renderer.js" },
      },
    })
    writeFileSync(path.join(root, "renderer/index.html"), '<div id="root"></div><script type="module" src="./renderer.js"></script>')
    writeFileSync(path.join(root, "preload.cjs"), `
      const { contextBridge, ipcRenderer } = require('electron');
      contextBridge.exposeInMainWorld('api', {
        awaitInitialization: () => ipcRenderer.invoke('initialize'),
        relaunch: () => ipcRenderer.send('relaunch'),
        openLink: () => {},
      });
    `)
    writeFileSync(path.join(root, "harness.cjs"), `
      const { app, BrowserWindow, ipcMain } = require('electron');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      app.setPath('userData', path.join(__dirname, 'profile'));
      app.disableHardwareAcceleration();
      let pending, restarts = 0;
      ipcMain.handle('initialize', () => new Promise((resolve, reject) => { pending = { resolve, reject }; }));
      ipcMain.on('relaunch', () => restarts++);
      async function until(read, label) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) { if (await read()) return; await new Promise(r => setTimeout(r, 20)); }
        throw new Error(label);
      }
      async function scenario(failure) {
        pending = undefined;
        const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs') } });
        const read = (js) => win.webContents.executeJavaScript(js);
        await win.loadFile(path.join(__dirname, 'renderer/index.html'));
        await until(() => pending, 'renderer never requested initialization');
        assert.match(await read('document.body.innerText'), /Starting Claxedo/);
        assert.equal(await read('!!document.querySelector("#ready-app")'), false);
        if (failure) {
          pending.reject(new Error('daemon lease acquire failed (409)'));
          await until(() => read('!!document.querySelector("[role=alert]")'), 'startup failure left a blank window');
          assert.match(await read('document.body.innerText'), /daemon lease acquire failed/);
          assert.equal(await read('!!document.querySelector("#ready-app")'), false);
          await read('document.querySelector("button").click()');
          await until(() => restarts === 1, 'restart action did not reach preload');
        } else {
          pending.resolve({ url: 'http://127.0.0.1:2593', password: null });
          await until(() => read('!!document.querySelector("#ready-app")'), 'ready App was not mounted');
          assert.equal(await read('document.querySelector("#ready-app").textContent'), 'http://127.0.0.1:2593');
          assert.equal(await read('!!document.querySelector("[role=status]")'), false);
        }
        win.destroy();
      }
      app.on('window-all-closed', () => {});
      app.whenReady().then(async () => { await scenario(true); await scenario(false); })
        .then(() => { console.log('STARTUP_OK'); app.exit(0); }, error => { console.error(error); app.exit(1); });
    `)
    const electron: string = createRequire(import.meta.url)("electron")
    const args = [electron, path.join(root, "harness.cjs")]
    if (process.platform === "linux") args.push("--no-sandbox")
    const cmd = process.platform === "linux" && !process.env.DISPLAY ? ["xvfb-run", "-a", ...args] : args
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" })
    const timeout = setTimeout(() => proc.kill(), 30_000)
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    clearTimeout(timeout)
    expect({ code, diagnostic: code ? stderr.slice(-3000) : "" }).toEqual({ code: 0, diagnostic: "" })
    expect(stdout).toContain("STARTUP_OK")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
