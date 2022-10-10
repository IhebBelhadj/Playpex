const { app, BrowserWindow } = require('electron')
const path = require('path')
const url = require('url')
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
        icon : path.join('assets/icons/app_icon.svg')
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
