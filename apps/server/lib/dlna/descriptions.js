'use strict';

// The device description and service descriptions (SCPD) of the DLNA server:
// a UPnP AV MediaServer:1 with ContentDirectory:1, ConnectionManager:1 and
// Microsoft's X_MS_MediaReceiverRegistrar:1 (Xbox and Windows Media Player
// ask for it; it authorizes everyone).

var escape = require('./xml').escape;

var CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1',
  CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1',
  MRR = 'urn:microsoft.com:service:X_MS_MediaReceiverRegistrar:1';

function device(info) {
  function service(type, id, name) {
    return '<service><serviceType>' + type + '</serviceType><serviceId>' + id + '</serviceId>' +
      '<SCPDURL>/dlna/' + name + '.xml</SCPDURL><controlURL>/dlna/control/' + name + '</controlURL>' +
      '<eventSubURL>/dlna/events/' + name + '</eventSubURL></service>';
  }
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0" xmlns:sec="http://www.sec.co.kr/dlna">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion><device>' +
    '<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>' +
    '<friendlyName>' + escape(info.name) + '</friendlyName>' +
    '<manufacturer>Playpex</manufacturer>' +
    '<modelDescription>Playpex Media Server</modelDescription><modelName>Playpex Media Server</modelName>' +
    '<modelNumber>' + escape(info.version) + '</modelNumber><serialNumber>' + escape(info.id) + '</serialNumber>' +
    '<UDN>' + escape(info.udn) + '</UDN>' +
    '<dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>' +
    // Samsung TVs read sidecar subtitles only from servers that say so
    '<sec:ProductCap>smi,DCM10,getMediaInfo.sec,getCaptionInfo.sec</sec:ProductCap>' +
    '<sec:X_ProductCap>smi,DCM10,getMediaInfo.sec,getCaptionInfo.sec</sec:X_ProductCap>' +
    '<presentationURL>' + escape(info.dashboard || '/') + '</presentationURL>' +
    '<serviceList>' +
    service(CDS, 'urn:upnp-org:serviceId:ContentDirectory', 'ContentDirectory') +
    service(CMS, 'urn:upnp-org:serviceId:ConnectionManager', 'ConnectionManager') +
    service(MRR, 'urn:microsoft.com:serviceId:X_MS_MediaReceiverRegistrar', 'X_MS_MediaReceiverRegistrar') +
    '</serviceList></device></root>';
}

// [name, [[argument, direction, related state variable], …]]
function scpd(actions, variables) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<actionList>' + actions.map(function (a) {
      return '<action><name>' + a[0] + '</name><argumentList>' + a[1].map(function (arg) {
        return '<argument><name>' + arg[0] + '</name><direction>' + arg[1] + '</direction>' +
          '<relatedStateVariable>' + arg[2] + '</relatedStateVariable></argument>';
      }).join('') + '</argumentList></action>';
    }).join('') + '</actionList><serviceStateTable>' + variables.map(function (v) {
      return '<stateVariable sendEvents="' + (v[2] ? 'yes' : 'no') + '"><name>' + v[0] + '</name><dataType>' + v[1] + '</dataType>' +
        (v[3] ? '<allowedValueList>' + v[3].map(function (x) { return '<allowedValue>' + x + '</allowedValue>'; }).join('') + '</allowedValueList>' : '') +
        '</stateVariable>';
    }).join('') + '</serviceStateTable></scpd>';
}

var CONTENT_DIRECTORY = scpd([
  ['GetSearchCapabilities', [['SearchCaps', 'out', 'SearchCapabilities']]],
  ['GetSortCapabilities', [['SortCaps', 'out', 'SortCapabilities']]],
  ['GetSystemUpdateID', [['Id', 'out', 'SystemUpdateID']]],
  ['Browse', [
    ['ObjectID', 'in', 'A_ARG_TYPE_ObjectID'],
    ['BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'],
    ['Filter', 'in', 'A_ARG_TYPE_Filter'],
    ['StartingIndex', 'in', 'A_ARG_TYPE_Index'],
    ['RequestedCount', 'in', 'A_ARG_TYPE_Count'],
    ['SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'],
    ['Result', 'out', 'A_ARG_TYPE_Result'],
    ['NumberReturned', 'out', 'A_ARG_TYPE_Count'],
    ['TotalMatches', 'out', 'A_ARG_TYPE_Count'],
    ['UpdateID', 'out', 'A_ARG_TYPE_UpdateID']
  ]]
], [
  ['SearchCapabilities', 'string'],
  ['SortCapabilities', 'string'],
  ['SystemUpdateID', 'ui4', true],
  ['ContainerUpdateIDs', 'string', true],
  ['A_ARG_TYPE_ObjectID', 'string'],
  ['A_ARG_TYPE_Result', 'string'],
  ['A_ARG_TYPE_BrowseFlag', 'string', false, ['BrowseMetadata', 'BrowseDirectChildren']],
  ['A_ARG_TYPE_Filter', 'string'],
  ['A_ARG_TYPE_SortCriteria', 'string'],
  ['A_ARG_TYPE_Index', 'ui4'],
  ['A_ARG_TYPE_Count', 'ui4'],
  ['A_ARG_TYPE_UpdateID', 'ui4']
]);

var CONNECTION_MANAGER = scpd([
  ['GetProtocolInfo', [['Source', 'out', 'SourceProtocolInfo'], ['Sink', 'out', 'SinkProtocolInfo']]],
  ['GetCurrentConnectionIDs', [['ConnectionIDs', 'out', 'CurrentConnectionIDs']]],
  ['GetCurrentConnectionInfo', [
    ['ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'],
    ['RcsID', 'out', 'A_ARG_TYPE_RcsID'],
    ['AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'],
    ['ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'],
    ['PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'],
    ['PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'],
    ['Direction', 'out', 'A_ARG_TYPE_Direction'],
    ['Status', 'out', 'A_ARG_TYPE_ConnectionStatus']
  ]]
], [
  ['SourceProtocolInfo', 'string', true],
  ['SinkProtocolInfo', 'string', true],
  ['CurrentConnectionIDs', 'string', true],
  ['A_ARG_TYPE_ConnectionStatus', 'string', false, ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown']],
  ['A_ARG_TYPE_ConnectionManager', 'string'],
  ['A_ARG_TYPE_Direction', 'string', false, ['Input', 'Output']],
  ['A_ARG_TYPE_ProtocolInfo', 'string'],
  ['A_ARG_TYPE_ConnectionID', 'i4'],
  ['A_ARG_TYPE_AVTransportID', 'i4'],
  ['A_ARG_TYPE_RcsID', 'i4']
]);

var RECEIVER_REGISTRAR = scpd([
  ['IsAuthorized', [['DeviceID', 'in', 'A_ARG_TYPE_DeviceID'], ['Result', 'out', 'A_ARG_TYPE_Result']]],
  ['IsValidated', [['DeviceID', 'in', 'A_ARG_TYPE_DeviceID'], ['Result', 'out', 'A_ARG_TYPE_Result']]],
  ['RegisterDevice', [['RegistrationReqMsg', 'in', 'A_ARG_TYPE_RegistrationReqMsg'],
    ['RegistrationRespMsg', 'out', 'A_ARG_TYPE_RegistrationRespMsg']]]
], [
  ['A_ARG_TYPE_DeviceID', 'string'],
  ['A_ARG_TYPE_Result', 'int'],
  ['A_ARG_TYPE_RegistrationReqMsg', 'bin.base64'],
  ['A_ARG_TYPE_RegistrationRespMsg', 'bin.base64'],
  ['AuthorizationGrantedUpdateID', 'ui4', true],
  ['AuthorizationDeniedUpdateID', 'ui4', true],
  ['ValidationSucceededUpdateID', 'ui4', true],
  ['ValidationRevokedUpdateID', 'ui4', true]
]);

module.exports = {
  CDS: CDS,
  CMS: CMS,
  MRR: MRR,
  device: device,
  services: {
    ContentDirectory: CONTENT_DIRECTORY,
    ConnectionManager: CONNECTION_MANAGER,
    X_MS_MediaReceiverRegistrar: RECEIVER_REGISTRAR
  }
};
