const { app, BrowserWindow } = require('electron')
const path = require('path')
const url = require('url')
const http = require('http')
const server = require('@playpex/server')
const express = require('express')
const shutdown = require('electron-shutdown-command');
var electron = express();
electron.listen(3344);

let win;

// The TV app still carries the server (until it's separated: step 9 of
// docs/server-separation-plan.md). If a Playpex server already runs on its
// port (e.g. `npm run server`), use that one; if something else holds the
// port, run ours on a free loopback port. Resolves with the port to use.
const serverPort = server.start().then(info => info.port, err => {
    if (err.code !== 'PORT_IN_USE') {
        throw err
    }
    return isPlaypexServer(err.port).then(found => {
        if (found) {
            console.log('Using the Playpex server already running on port ' + err.port)
            return err.port
        }
        return server.start({ port: 0, host: '127.0.0.1' }).then(info => info.port)
    })
})

function isPlaypexServer(port) {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/server', timeout: 2000 }, res => {
            let body = ''
            res.on('data', d => body += d)
            res.on('end', () => {
                try {
                    const info = JSON.parse(body)
                    resolve(res.statusCode === 200 && !!info.id && info.apiVersion >= 1)
                } catch (e) {
                    resolve(false)
                }
            })
        })
        req.on('timeout', () => req.destroy())
        req.on('error', () => resolve(false))
    })
}

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
        icon : path.join(__dirname, '..', 'favicon.ico')
    });
    win.setBackgroundColor('#000');
    // Tell the UI which port the streaming server got (see src/app/server-config.ts)
    serverPort.then(port => {
        win.loadURL(url.format({
            pathname: path.join(__dirname, '../dist/playpex/index.html'),
            protocol: 'file',
            slashes: true,
            query: { streamer: port }
        }));
    });
    /*if (isDev()) {
        win.webContents.openDevTools()
    }*/
    win.on('closed', () => {
        win = null
    })
}
app.on('ready', createWindow)

// Let the server destroy its torrent engines before quitting
let serverStopped = false
app.on('before-quit', event => {
    if (serverStopped) {
        return
    }
    event.preventDefault()
    server.stop().catch(() => {}).then(() => {
        serverStopped = true
        app.quit()
    })
})
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
