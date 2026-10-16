class Util {
    static getExtension(filename){
        var parts = filename.toString().split('.');
        return parts[parts.length - 1];
    }

    static isVideo(file){
        var ext = Util.getExtension(file);
        switch (ext.toLowerCase()) {
          case 'm4v':
          case 'avi':
          case 'mpg':
          case 'mkv':
          case 'mp4':
            // etc
            return true;
        }
        return false;
    }
}

module.exports = Util;