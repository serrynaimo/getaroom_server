// Require modules
var express = require('express'),
    cors = require('cors'),
    redis = require('redis'),
    nodemailer = require('nodemailer'),
    ses = require('nodemailer-ses-transport'),
    sns = require('sns-mobile'),
    gcm = require('node-gcm'),
    extend = require('extend'),
    util = require('util'),
    settings = require('./config/config.js');

// App/Express settings
app = exports.app = express();

app.set('port', process.env.PORT || 8001)
  .set('env', process.env.NODE_ENV || 'local');
  // .set('env', process.env.NODE_ENV || 'dev');

app.use(cors());

// Configuration and Constants
var config = require('./config/' + app.get('env') + '.js'),
    emailPattern = /^[a-z0-9_+.-]+@[a-z0-9.-]+\.[a-z0-9]{2,}$/;

// Transport initilization
var admTransport = new sns(config.aws),
    gcmTransport = new gcm.Sender( settings.googleSettings.apiKey ),
    mailTransport = nodemailer.createTransport(ses(extend(config.aws, {
        region: 'us-west-2', // ap-southeast-1 not supported
        rateLimit: 5
    }))),
    // client stores user objects with userId as key:
    // { userId: Encoded email, cloud: ADM/GCM, endpointArn: ADM/GCM registration ID }
    client = redis.createClient();

// Helper functions
var decodeId = function (id) {
        if(!id || id.length <= 6)
            return "";
        id = id.replace("-", "/").replace("_","+") + "=";
        return new Buffer(id, 'base64').toString('ascii');
    },
    sendEmail = function(caller, callee, room, callback) {
        mailTransport.sendMail({
            from: caller + ' <' + config.sendFromEmail + '>',
            replyTo: caller,
            to: callee,
            subject: "Join me on a video call right now",
            text: "Hey there,\n\n" + caller + " is waiting for you on " + config.domain + " to be joined for a video call. It's a free tool and you don't need to sign up or install anything. Just follow this link and put pants on ;)\n\nhttp://" + config.domain + "/" + room + "\n\n"
        }, callback);
    },
    sendADM = function( emailCaller, endpointArn, room, emailCallee, callback ) {
      // Create ADM message in JSON
      var notification = {
        default: emailCaller + ' is calling. Go to http://' + config.domain + '/' + room + ' to accept the call.',
        ADM: JSON.stringify({
          data: {
            message: emailCaller + ' is calling ...',
            room: room,
            emailCaller: emailCaller,
            emailCallee: emailCallee
          },
          expiresAfter: 60
        }),
        GCM: JSON.stringify({
          data: {
            message: emailCaller + ' is calling ...',
            room: room,
            emailCaller: emailCaller,
            emailCallee: emailCallee
          },
          time_to_live: 60
        })
      };
      // Send message via ADM.
      admTransport.sendMessage(endpointArn, notification, callback);
    },
    // Send a message via GCM
    sendGCM = function( emailCaller, endpointArn, room, emailCallee, callback ) {
      // Create GCM message in JSON.
      var message = new gcm.Message({
        collapseKey: 'Invitation',
        // delayWhileIdle: true,
        data: {
          message: emailCaller + ' is calling ...',
          room: room,
          emailCaller: emailCaller,
          emailCallee: emailCallee
        },
        timeToLive: 60
      });
      // Create sender list
      var registrationIds = [];   
      registrationIds.push( endpointArn );
      // Send message via GCM
      gcmTransport.send( message, registrationIds, 4, callback );
    },
    // Log with util.inspect, which returns a string representation of object.
      // Shows non-enumerable properties.
      // Recurse indefinitely into object.
      // Output will be styled with ANSI color codes
    logUI = function( logObject ) {
      console.log( util.inspect(
       logObject, { showHidden: true, depth: null, colors: true } ) );
    }

// Event subscriptions
client.on("error", function(err) {
    console.log("Redis error: " + err);
});

// Endpoint definitions
app.get('/register', function (req, res) {
  var userId = req.query.id,
      regId = req.query.device,
      cloud = req.query.cloud,
      emailUser = decodeId( userId );

  // A valid reqister call must have all 3 values.
  if( userId && regId && cloud ) {

    /*if(req.query.device.indexOf('.adm-registration.') < 0) {
      console.log("Did not register device request for '" + req.query.device + "'");
      res.status(200).send('OK');
      return;
    }*/

    // Add user to database
      // ADM
    if( cloud == 'ADM' ) {
      admTransport.addUser(req.query.device, null, function(err, endpointArn) {
        if(err) {
          console.log("SNS Error:" + err);
          return res.status(500).send('SNS Error');
        }
        // Create user object
        var user = { userId: userId, cloud: cloud, endpointArn: endpointArn };
        client.set( userId, JSON.stringify( user ), redis.print );

        console.log("Registered " + cloud + " device '" + req.query.device +
          "' with endpoint " + endpointArn);
        res.status(200).send('OK');
      });
    } else if( cloud == 'GCM' ) {
      // GCM
        // Create user object
      var user = { userId: userId, cloud: cloud, endpointArn: regId };
      client.set( userId, JSON.stringify( user ), redis.print );

      console.log( "Registered user " + emailUser + " with id " + userId + ", via " + cloud + " device token and endpoint: "
       + regId );
      res.status(200).send('OK');
    }
  }
  else {
    res.status(400).send('Bad Request');
  }
});

app.get('/call', function (req, res) {
  var idCaller = req.query.caller,
      idCallee = req.query.callee,
      actionType = req.query.action,
      emailCaller = decodeId( idCaller ),
      emailCallee = decodeId( idCallee );

  if(!emailCaller.match(emailPattern) || !emailCallee.match(emailPattern)) {
    res.status(400).send( 'Bad Request. Ensure you have id, device, cloud.' );
    return;
  }

  if( actionType == 'inviteCancel' ) {
    // Caller is cancelling the invite.
    // Push notification to Callee.
    
  } else if( actionType == 'inviteAccept' ) {
    // Callee has accepted invite.
    // Push notification to Caller.
    
  } else if( actionType == 'inviteDecline' ) {
    // Callee has declined invite.
    // Push notification to Caller.
    
  } else {
    client.get(idCallee, function( err, userStr ){
      // Email is sent for following cases:
        // callee is not registered, i.e. not found in database.
        // callee is registered but redis has problem retrieving record.
        // sending of notification failed, for e.g. if registration id is wrong.
      var mailCallback = function(err) {
        if(err) {
          console.log('SES Error: Email could not be delivered to ' + emailCallee + '. ' + err);
          res.status(500).send('Server Error');
        }
        else {
          console.log("Sent Email to " + emailCallee);
          res.status(200).send('OK');
        }
      };

      if( !err ) {
      // If callee is registered (can be found in database) and successfully retrieved.
        if( userStr != 'nil' ) {
          var user = JSON.parse( userStr );
          var cloud = user.cloud;
          var endpointArn = user.endpointArn;

          var notificationCallback = function(err, messageId) {
            if(err) {
              console.log( 'SNS Error: ' + cloud + ' notification from ' + emailCaller + 
                '\ncould not be delivered to ' + emailCallee + 
                '\nat device endpoint ' + endpointArn + '.\n' + err );
              sendEmail( emailCaller, emailCallee, idCaller, mailCallback );
            } else {
              console.log( "Sent Notification from " + emailCaller + " to " + emailCallee + 
                '\nat device endpoint ' + endpointArn + '\nmessageId:\n' );
              // 2nd parameter (messageId) in callback for may contain canonical id(s) for GCM,
                // If the current device id used is not the latest registered device id.
              logUI( messageId );
              res.status(200).send('OK');
            }
          };

          // Send to the right cloud
          if( cloud == 'ADM')
            sendADM(emailCaller, endpointArn, idCaller, emailCallee, notificationCallback);
          else if( cloud == 'GCM' )
            sendGCM(emailCaller, endpointArn, idCaller, emailCallee, notificationCallback);
        } else {
          // callee is not registered
          sendEmail( emailCaller, emailCallee, idCaller, mailCallback );
        }
      } else {
        // callee is registered but redis has problem retrieving record,
          // e.g. if record is not a string.
        sendEmail( emailCaller, emailCallee, idCaller, mailCallback );
      }
    });
  }
});

// Startup
app.listen(app.get('port'));

console.log('Server envorinment: ' + app.get('env') +
    ' - API listening on port: ' + app.get('port'));
