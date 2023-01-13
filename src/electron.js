const { app, BrowserWindow } = require('electron')
const path = require('path')
const url = require('url')
const server = require('./server/streamingServer/server')
const express = require('express')
const shutdown = require('electron-shutdown-command');
var electron = express();
electron.listen(3344);

let win;

function isDev() {
    return process.mainModule.filename.indexOf('app.asar') === -1;
};
function createWindow() {

    win = new BrowserWindow({
        fullscreen : true  ,
        frame: false ,
        height:780,
        width:1270,
        webPreferences: {
            nodeIntegrationInWorker: true
        },
        icon : 'favicon.ico'
    });
    win.setBackgroundColor('#000');
    win.loadURL(url.format({
        pathname: path.join(__dirname, '../dist/playpex/index.html'),
        protocol: 'file',
        slashes: true
    }));
    /*if (isDev()) {
        win.webContents.openDevTools()
    }*/
    win.on('closed', () => {
        win = null
    })
}
app.on('ready', createWindow)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})
app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
})

electron.get('/power/:action' , function(req , res){
  var action = req.params.action;
  console.log(action);
  switch (action) {
    case "quit":
      app.quit();
      break;
    case "shutdown":
      shutdown.shutdown();
      break;
    case "sleep":
      shutdown.sleep();
      break;
    case "restart":
      shutdown.reboot();
      break;
    default:
      console.log("unidentified request");
      break;
  }
})

function handleSquirrelEvent(application) {
  if (process.argv.length === 1) {
      return false;
  }

  const ChildProcess = require('child_process');
  const path = require('path');

  const appFolder = path.resolve(process.execPath, '..');
  const rootAtomFolder = path.resolve(appFolder, '..');
  const updateDotExe = path.resolve(path.join(rootAtomFolder, 'Update.exe'));
  const exeName = path.basename(process.execPath);

  const spawn = function(command, args) {
      let spawnedProcess, error;

      try {
          spawnedProcess = ChildProcess.spawn(command, args, {
              detached: true
          });
      } catch (error) {}

      return spawnedProcess;
  };

  const spawnUpdate = function(args) {
      return spawn(updateDotExe, args);
  };

  const squirrelEvent = process.argv[1];
  switch (squirrelEvent) {
      case '--squirrel-install':
      case '--squirrel-updated':
          // Optionally do things such as:
          // - Add your .exe to the PATH
          // - Write to the registry for things like file associations and
          //   explorer context menus

          // Install desktop and start menu shortcuts
          spawnUpdate(['--createShortcut', exeName]);

          setTimeout(application.quit, 1000);
          return true;

      case '--squirrel-uninstall':
          // Undo anything you did in the --squirrel-install and
          // --squirrel-updated handlers

          // Remove desktop and start menu shortcuts
          spawnUpdate(['--removeShortcut', exeName]);

          setTimeout(application.quit, 1000);
          return true;

      case '--squirrel-obsolete':
          // This is called on the outgoing version of your app before
          // we update to the new version - it's the opposite of
          // --squirrel-updated

          application.quit();
          return true;
  }
};
