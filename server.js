// Require modules
var express = require('express'),
    cors = require('cors'),
    Enum = require('enum'),
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

// Enums
  // User's registration status, including state of database record:
var RegStatus = new Enum ({
  // Possible status:
    // callee is registered with proper record in database.
    'REGISTERED': 0,
    // callee is not registered, i.e. not found in database.
    'UNREGISTERED': 1,
    // callee is registered but redis has problem retrieving record.
    'RECORD_ERROR': 2,
});
  // Type of API action to be performed.
var ActionType = new Enum ({
  // Possible types:
    // Caller is making the invite.
  'INVITE_INVITE': 'inviteInvite',
    // Caller is cancelling the invite.
  'INVITE_CANCEL': 'inviteCancel',
    // Callee has accepted invite.
  'INVITE_ACCEPT': 'inviteAccept',
    // Callee has declined invite.
  'INVITE_DECLINE': 'inviteDecline',
});
  // Type of cloud notification, e.g. ADM, GCM.
var CloudType = new Enum ({
  // Possible types:
  'ADM': 'ADM',
  'GCM': 'GCM',
});

// Helper functions
var decodeId = function (id) {
        if(!id || id.length <= 6)
            return "";
        id = id.replace("-", "/").replace("_","+") + "=";
        return new Buffer(id, 'base64').toString('ascii');
    },
    getEnumFromValue = function( enumArray, val ) {
      // Go through array of enum and return the one that matches value.
      for( var i = 0, len = enumArray.length; i < len; ++i ) {
        if( enumArray[ i ].value == val )
          return enumArray[ i ];
      }
      return undefined;
    },
    sendEmail = function( caller, callee, room, callback, actionType ) {
      var emailText, subjectText, emailSender, emailReceiver;
      emailSender = caller;
      emailReceiver = callee;
      switch( actionType ) {
        case ActionType.INVITE_INVITE:
          emailText = 
            "Hey there,\n\n" + caller + " is waiting for you on " + config.domain + 
            " to be joined for a video call. It's a free tool and you don't need to sign up " + 
            "or install anything. Just follow this link and you're all set :)\n\n" +
            "http://" + config.domain + "/" + room + "\n\n";
          subjectText = "Join me on a video call right now";
          break;
        case ActionType.INVITE_CANCEL:
          emailText = caller + " has canceled the video call they started.";
          subjectText = emailText;
          break;
        case ActionType.INVITE_ACCEPT:
          emailText = callee + " has accepted the video call you started.";
          emailSender = callee;
          emailReceiver = caller;
          subjectText = emailText;
          break;
        case ActionType.INVITE_DECLINE:
          emailText = callee + " has declined the video call you started.";
          emailSender = callee;
          emailReceiver = caller;
          subjectText = emailText;
          break;
      }
        mailTransport.sendMail({
            from: emailSender + ' <' + config.sendFromEmail + '>',
            replyTo: emailSender,
            to: emailReceiver,
            subject: subjectText,
            text: emailText
        }, callback);
    },
    sendCloud = function( emailCaller, endpointArn, room, emailCallee, callback, cloud, actionType ) {
      var dataCloud = {
        INVITATION_MESSAGE: '',
        INVITATION_ROOM: room,
        INVITATION_EMAIL_CALLER: emailCaller,
        INVITATION_EMAIL_CALLEE: emailCallee,
        INVITATION_TYPE: actionType.value,
      };
      // Set the right message
      switch( actionType ) {
        case ActionType.INVITE_INVITE:
          dataCloud.INVITATION_MESSAGE = emailCaller + ' is calling ...';
          break;
        case ActionType.INVITE_CANCEL:
          dataCloud.INVITATION_MESSAGE = emailCaller + " has canceled the video call they started.";
          break;
        case ActionType.INVITE_ACCEPT:
          dataCloud.INVITATION_MESSAGE = emailCallee + " has accepted the video call you started.";
          break;
        case ActionType.INVITE_DECLINE:
          dataCloud.INVITATION_MESSAGE = emailCallee + " has declined the video call you started.";
          break;
      }

      console.log( '[' + ( new Date() ).toLocaleString() + '] Data to be sent:\n' + JSON.stringify( dataCloud ) );
      switch ( cloud ) {
        case CloudType.ADM:
          // Create ADM message in JSON
          var notification = {
            default: emailCaller + ' is calling. Go to http://' + config.domain + '/' + room + ' to accept the call.',
            ADM: JSON.stringify({
              data: dataCloud,
              expiresAfter: 60
            }),
          };
          // Send message via ADM.
          admTransport.sendMessage(endpointArn, notification, callback);
          break;
        case CloudType.GCM:
          // Create GCM message in JSON.
          var message = new gcm.Message({
            collapseKey: 'Invitation',
            // delayWhileIdle: true,
            data: dataCloud,
            timeToLive: 60
          });
          // Create sender list
          var registrationIds = [];   
          registrationIds.push( endpointArn );
          // Send message via GCM
          gcmTransport.send( message, registrationIds, 4, callback );
          break;
        default:
          console.log( 'Unknown cloud type used: ' + cloud.toString() );
      }
    },
    // Log with util.inspect, which returns a string representation of object.
      // Shows non-enumerable properties.
      // Recurse indefinitely into object.
      // Output will be styled with ANSI color codes
    logUI = function( logObject ) {
      console.log( util.inspect(
       logObject, { showHidden: true, depth: null, colors: true } ) );
    };

// Event subscriptions
client.on("error", function(err) {
    console.log("Redis error: " + err);
});

// Endpoint definitions
app.get('/register', function (req, res) {
  var userId = req.query.id,
      regId = req.query.device,
      cloud = req.query.cloud,
      cloudType = getEnumFromValue( CloudType.enums, cloud ),
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
    if( cloudType == CloudType.ADM ) {
      admTransport.addUser(req.query.device, null, function(err, endpointArn) {
        if(err) {
          console.log("SNS Error:" + err);
          return res.status(500).send('SNS Error');
        }
        // Create user object
        var user = { userId: userId, cloud: cloudType.value, endpointArn: endpointArn };
        client.set( userId, JSON.stringify( user ), redis.print );
        logUI( 'User object is\n:' + JSON.stringify( user ) );
      });
    } else if( cloudType == CloudType.GCM ) {
      // GCM
        // Create user object
      var user = { userId: userId, cloud: cloudType.value, endpointArn: regId };
      client.set( userId, JSON.stringify( user ), redis.print );
      logUI( 'User object is\n:' + JSON.stringify( user ) );
    }
    console.log( "Registered user " + emailUser + " with id " + userId + ", via " + cloud + 
      " device token and endpoint: " + regId );
    res.status(200).send('OK');
  }
  else {
    res.status(400).send('Bad Request');
  }
});

app.get('/call', function (req, res) {
  var idCaller = req.query.caller,
      idCallee = req.query.callee,
      action = req.query.action,
      actionType = getEnumFromValue( ActionType.enums, action ),
      emailCaller = decodeId( idCaller ),
      emailCallee = decodeId( idCallee );

  // Check for proper parameters
    // Check email formats
  if(!emailCaller.match(emailPattern) || !emailCallee.match(emailPattern)) {
    var errStr = 
      'Bad Request. Ensure you have encoded a valid email address for both caller and callee.';
    res.status(400).send( errStr );
    console.log( errStr );
    return;
  }
    // Check actionType defined.
  if( typeof( actionType ) == 'undefined' ) {
    var errStr = 'Bad Request. Ensure you have included an action parameter.\n' + 
    'action: ' + action + '\nactionType: ' + actionType;
    res.status( 400 ).send( errStr );
    console.log( errStr );
    return;
  }

  // Check registration status of callee.
  var cloudReceiver,
      regStatus,
      user;

  // Set the right cloudReceiver
  switch( actionType ) {
    case ActionType.INVITE_INVITE:
      cloudReceiver = idCallee;
      break;
    case ActionType.INVITE_CANCEL:
      cloudReceiver = idCallee;
      break;
    case ActionType.INVITE_ACCEPT:
      cloudReceiver = idCaller;
      break;
    case ActionType.INVITE_DECLINE:
      cloudReceiver = idCaller;
      break;
  }

  console.log( 'cloudReceiver is: ' + cloudReceiver + '.' );

  client.get( cloudReceiver, function( err, userStr ){
    // CloudReceiver may have following registration status:
      // cloudReceiver is registered with proper record in database.
      // cloudReceiver is not registered, i.e. not found in database.
      // cloudReceiver is registered but redis has problem retrieving record.

    if( !err ) {
    // If cloudReceiver is registered (can be found in database) and successfully retrieved.
      console.log( '[REDIS] userStr is: ' + userStr + '.' );
      if( userStr != null && userStr != 'nil' ) {
        regStatus = RegStatus.REGISTERED;
        user = JSON.parse( userStr );
        logUI( "RegStatus: cloudReceiver userStr found in db:\n" + userStr );
        logUI( "RegStatus: cloudReceiver user object:\n" + user );
      } else {
        // cloudReceiver is not registered
        regStatus = RegStatus.UNREGISTERED;
        console.log( 'RegStatus: cloudReceiver NOT found in db.' );
      }
    } else {
      // cloudReceiver is registered but redis has problem retrieving record,
        // e.g. if record is not a string.
      regStatus = RegStatus.RECORD_ERROR;
      console.log( 'RegStatus: cloudReceiver found in db, but there is a problem retrieving record:\n' +
        err );
    }

    // Process call request.
    processCallAction( actionType );
  });

  // Send notification depending on action request.
  var processCallAction = function( actionType ){
    // Email is sent for following cases:
      // callee is registered.
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
    switch( regStatus ) {
      case RegStatus.REGISTERED:
        // If callee is registered (can be found in database) and successfully retrieved.
        var cloud = user.cloud;
        var cloudType = getEnumFromValue( CloudType.enums, cloud );
        var endpointArn = user.endpointArn;

        var notificationCallback = function( err, messageId ) {
          if(err) {
            console.log( 'SNS Error: ' + cloud + ' notification from ' + emailCaller + 
              '\ncould not be delivered to ' + emailCallee + 
              '\nat device endpoint ' + endpointArn + '.\n' + err );
            sendEmail( emailCaller, emailCallee, idCaller, mailCallback, actionType );
          } else {
            console.log( '[' + ( new Date() ).toLocaleString() + '] Sent Notification from ' + 
              emailCaller + " to " + emailCallee + 
              '\nat device endpoint ' + endpointArn + '\nmessageId:\n' );
            // 2nd parameter (messageId) in callback for may contain canonical id(s) for GCM,
              // If the current device id used is not the latest registered device id.
            logUI( messageId );
            // Send email in any case.
            sendEmail( emailCaller, emailCallee, idCaller, mailCallback, actionType );
          }
        };
        // Send to the right cloud
        sendCloud( emailCaller, endpointArn, idCaller, emailCallee, notificationCallback,
          cloudType, actionType );
        break;
      case RegStatus.UNREGISTERED:
          // callee is not registered
      case RegStatus.RECORD_ERROR:
          // callee is registered but redis has problem retrieving record,
            // e.g. if record is not a string.
          sendEmail( emailCaller, emailCallee, idCaller, mailCallback, actionType );
        break;
      default:
        // Unknown registration status.
        console.log( "Tried to send Notification from " + emailCaller + " to " + emailCallee + 
          '\nat device endpoint ' + endpointArn + ',\nbut Callee has unknown regStatus: ' +
          regStatus.toString() + '.' );
    }
  }
});

// Startup
app.listen(app.get('port'));

console.log('Server envorinment: ' + app.get('env') +
    ' - API listening on port: ' + app.get('port'));
