/*
 * == BSD2 LICENSE ==
 * Copyright (c) 2018, Tidepool Project
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the associated License, which is identical to the BSD 2-Clause
 * License as published by the Open Source Initiative at opensource.org.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the License for more details.
 *
 * You should have received a copy of the License along with this program; if
 * not, you can obtain one from Tidepool Project at tidepool.org.
 * == BSD2 LICENSE ==
 */

var _ = require('lodash');
var async = require('async');
var sundial = require('sundial');
var crcCalculator = require('../../crc.js');
var struct = require('../../struct.js')();
var annotate = require('../../eventAnnotations');

var TZOUtil = require('../../TimezoneOffsetUtil');

var isBrowser = typeof window !== 'undefined';
var debug = isBrowser ? require('bows')('TrueMetrixDriver') : debug;


module.exports = function (config) {
  var cfg = _.clone(config);
  var hidDevice = config.deviceComms;
  var messageBuffer = [];

  // With no date & time settings changes available,
  // timezone is applied across-the-board
  cfg.tzoUtil = new TZOUtil(cfg.timezone, new Date().toISOString(), []);

  /* end */

  var probe = function(cb){
    debug('attempting probe of Bayer Contour Next');
  };

  var extractPacketIntoMessage = function (bytes) {
    var packet_len = struct.extractByte(bytes, 0);
    var byte1 = struct.extractByte(bytes, 1);

  };

  var buildPacket = function (command, cmdlength) {
    var datalen = cmdlength + 4; // we use 4 bytes because we add 3 bytes for
                                 // the header and 1 byte for the length of
                                 // the payload
    var buf = new ArrayBuffer(datalen);
    var bytes = new Uint8Array(buf);
    var ctr = 0;
    if (cmdlength) {
      ctr += struct.pack(bytes, ctr, 'bb', cmdlength, command);
    }
    return buf;
  };

  /**
   * Calculates checksum for specified ASTM Frame.
   * @param {string} frame - The ASTM Frame to checksum
   * @return {string} Checksum value returned as a byte sized integer in hex base
   */
  function makeChecksum (frame) {
    var sum = frame.split('').reduce( function (previousValue, currentValue, currentIndex, array) {
      return (currentIndex == 1 ? previousValue.charCodeAt(0) : previousValue) + currentValue.charCodeAt(0);
    });
    return ('00' + (sum % 256).toString(16).toUpperCase()).substr(-2);
  }

  function decodeMessage (message) {

  }

  var parseDataRecord = function (data, callback){
    // TODO - The NextLink 2.4 also includes seconds in its timestamp (14 digits)
    var result = data.match(/^R\|(\d+)\|\^\^\^Glucose\|([0-9.]+)\|(\w+\/\w+).*\|{2}(.*)\|{2}(\d{12}).*/);
    if (result != null) {
      result = result.slice(1,6);
    }
    callback(null, result);
  };

  var getAnnotations = function (annotation, data){
    var annInfo = [];

    if (data.unreportedThreshold) {
      annInfo.push({
        code: 'bayer/smbg/unreported-hi-lo-threshold'
      });
    }
    if (annotation.indexOf('>') !== -1) {

      annInfo.push({
        code: 'bg/out-of-range',
        threshold: data.hiThreshold,
        value: 'high'
      });

      return annInfo;
    } else if (annotation.indexOf('<') !== -1) {

      annInfo.push({
        code: 'bg/out-of-range',
        threshold: data.lowThreshold,
        value: 'low'
      });

      return annInfo;
    } else {
      return null;
    }
  };

  var isControl = function(markers) {
    if(markers.indexOf('C') !== -1) {
      debug('Marking as control test');
      return true;
    } else {
      return false;
    }
  };

  var getOneRecord = function (data, callback) {
    var retry = 0;
    var robj = {};
    var error = false;

    var cmd = '(^)AF';

    async.doWhilst(
      function (whilstCb) {
        commandResponse(cmd, function (err, record) {
          if (err) {
            return whilstCb(err, null);
          } else {
            console.log('Record:', record);
          }
        });
      },
      function () { return (Object.getOwnPropertyNames(robj).length === 0) && !error; },
      function (err) {
        if (err) {
          error = true;
          debug('Failure trying to talk to device.');
          debug(err);
          return callback(err, null);
        } else {
          callback(null, robj);
        }
      }
    );
  };

  var commandResponse = function (commandpacket, callback) {
    hidDevice.send(commandpacket, function () {
      getASTMMessage(5000, 3, function(err, result) {
        if (err) {
          return callback(err, null);
        } else {
            var message = null;
            try {
              message = decodeMessage(result.bytes);
            } catch (err) {
              debug('Error:', err);
              return callback(err, null);
            }
            callback(null, message);
        }
      });
    });
  };

  var getASTMMessage = function (timeout, retries, cb) {

    var timedOut = false;

    var abortTimer = setTimeout(function () {
      debug('TIMEOUT');
      var e = new Error('Timeout error.');
      e.name = 'TIMEOUT';
      timedOut = true;
      return cb(e, null);
    }, timeout);

    var message;

    async.doWhilst(
      function (callback) {
        hidDevice.receive(function(raw) {
          try {
            var packet = new Uint8Array(raw);
            message = extractPacketIntoMessage(packet);

            // Only process if we get data
            if ( packet.length === 0 ) {
              return callback(null, false);
            }
            return callback(null, true);

          } catch (err) {
            debug('Error:', err);
            if (!timedOut) {
              return cb(err);
            }
          }
        });
      },
      function (valid) {
        return (valid !== true && !timedOut);
      },
      function (err) {
        return cb(err, message);
      });
  };

  var processReadings = function(readings) {
    _.each(readings, function(reading, index) {

    });
  };

  var prepBGData = function (progress, data) {
    //build missing data.id
    data.id = data.model + '-' + data.serialNumber;
    cfg.builder.setDefaults({ deviceId: data.id});
    var dataToPost = [];
    if (data.bgmReadings.length > 0) {
      for (var i = 0; i < data.bgmReadings.length; ++i) {
        var datum = data.bgmReadings[i];
        if(datum.control === true) {
          debug('Discarding control');
          continue;
        }
        var smbg = cfg.builder.makeSMBG()
          .with_value(datum.glucose)
          .with_deviceTime(datum.displayTime)
          .with_timezoneOffset(datum.timezoneOffset)
          .with_conversionOffset(datum.conversionOffset)
          .with_time(datum.displayUtc)
          .with_units(datum.units)
          .set('index', datum.nrec)
          .done();
          if (datum.annotations) {
            _.each(datum.annotations, function(ann) {
              annotate.annotateEvent(smbg, ann);
            });
          }
        dataToPost.push(smbg);
      }
    } else {
      debug('Device has no records to upload');
      throw(new Error('Device has no records to upload'));
    }

    return dataToPost;
  };

  return {
    detect: function(deviceInfo, cb){
      debug('no detect function needed', arguments);
      cb(null, deviceInfo);
    },

    setup: function (deviceInfo, progress, cb) {
      debug('in setup!');
      progress(100);
      cb(null, {deviceInfo: deviceInfo});
    },

    connect: function (progress, data, cb) {
      debug('in connect!');

      cfg.deviceComms.connect(data.deviceInfo, probe, function(err) {
        if (err) {
          return cb(err);
        }
        data.disconnect = false;
        progress(100);
        console.log("done with connect");
        cb(null, data);
      });
    },

    getConfigInfo: function (progress, data, cb) {
      debug('in getConfigInfo', data);

      getOneRecord({}, function (err, result) {
          progress(100);

          if(!err){
              data.connect = true;
              _.assign(data, result);

              cb(null, data);
          } else {
              return cb(err,result);
          }
      });
    },

    fetchData: function (progress, data, cb) {
      debug('in fetchData', data);
/*
      var recordType = null;
      var dataRecords = [];
      var error = false;

      async.whilst(
        // Get records from the meter until we get the Message Terminator Record (L)
        // The spec says that unless we get this, any preceding data should not be used.
        function () { return (recordType !== ASCII_CONTROL.EOT && recordType !== 'L' && !error); },
        function (callback) {
          getOneRecord(data, function (err, result) {
            if (err) {
              error = true;
            } else {
              recordType = result.recordType;
              // We only collect data records (R)
              if (recordType === 'R' && result.timestamp) {
                progress(100.0 * result.nrec / data.nrecs);
                dataRecords.push(result);
              }
            }
            return callback(err);
          });
        },
        function (err) {
          progress(100);
          if(err || error) {
            data.bgmReadings = [];
          } else {
            debug('fetchData', dataRecords);
            data.bgmReadings = dataRecords;
          }
          data.fetchData = true;
          cb(err, data);
        }
      );
      */
      cb(null,data);
    },

    processData: function (progress, data, cb) {
      /*
      //debug('in processData');
      progress(0);
      data.bg_data = processReadings(data.bgmReadings);
      try {
        data.post_records = prepBGData(progress, data);
        var ids = {};
        for (var i = 0; i < data.post_records.length; ++i) {
          delete data.post_records[i].index; // Remove index as Jaeb study uses logIndices instead
          var id = data.post_records[i].time + '|' + data.post_records[i].deviceId;
          if (ids[id]) {
            debug('duplicate! %s @ %d == %d', id, i, ids[id] - 1);
            debug(data.post_records[ids[id] - 1]);
            debug(data.post_records[i]);
          } else {
            ids[id] = i + 1;
          }
        }
        progress(100);
        data.processData = true;
        cb(null, data);
      }
      catch(err) {
        cb(new Error(err), null);
      }
      */
      cb(null, data);
    },

    uploadData: function (progress, data, cb) {
      /*

      var model = MODELS[data.model];
      if(model == null) {
        model = 'Unknown Bayer model';
      }
      debug('Detected as: ', model);

      progress(0);
      var sessionInfo = {
        deviceTags: ['bgm'],
        deviceManufacturers: ['Bayer'],
        deviceModel: model,
        deviceSerialNumber: data.serialNumber,
        deviceId: data.id,
        start: sundial.utcDateString(),
        timeProcessing: cfg.tzoUtil.type,
        tzName : cfg.timezone,
        version: cfg.version
      };

      cfg.api.upload.toPlatform(data.post_records, sessionInfo, progress, cfg.groupId, function (err, result) {
        progress(100);

        if (err) {
          debug(err);
          debug(result);
          return cb(err, data);
        } else {
          data.cleanup = true;
          return cb(null, data);
        }
      });
      */
      cb(null, data);

    },

    disconnect: function (progress, data, cb) {
      debug('in disconnect');
      cfg.deviceComms.removeListeners();
      // Due to an upstream bug in HIDAPI on Windoze, we have to send a command
      // to the device to ensure that the listeners are removed before we disconnect
      // For more details, see https://github.com/node-hid/node-hid/issues/61
      hidDevice.send(buildPacket([0x04],1), function(err, result) {
        progress(100);
        cb(null, data);
      });
    },

    cleanup: function (progress, data, cb) {
      debug('in cleanup');
      if(!data.disconnect){
          cfg.deviceComms.disconnect(data, function() {
              progress(100);
              data.cleanup = true;
              data.disconnect = true;
              cb(null, data);
          });
      } else {
        progress(100);
      }
    }
  };
};