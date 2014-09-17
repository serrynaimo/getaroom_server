// Require modules
var express = require('express'),
    cors = require('cors'),
    redis = require('redis'),
    nodemailer = require('nodemailer'),
    ses = require('nodemailer-ses-transport'),
    sns = require('sns-mobile'),
    extend = require('extend');

// App/Express settings
app = exports.app = express();

app.set('port', process.env.PORT || 8001)
    .set('env', process.env.NODE_ENV || 'local');

app.use(cors());

// Configuration and Constants
var config = require('./config/' + app.get('env') + '.js'),
    emailPattern = /^[a-z0-9_+.-]+@[a-z0-9.-]+\.[a-z0-9]{2,}$/;

// Transport initilization
var notificationTransport = new sns(config.aws),
    mailTransport = nodemailer.createTransport(ses(extend(config.aws, {
        region: 'us-west-2', // ap-southeast-1 not supported
        rateLimit: 5
    }))),
    client = redis.createClient();

// Helper functions
var decodeId = function (id) {
        if(!id || id.length < 5)
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
    sendNotification = function(caller, endpointArn, room, callback) {
        var notification = {
            default: caller + ' is calling. Go to http://' + config.domain + '/' + room + ' to accept the call.',
            ADM: JSON.stringify({
                data: {
                    message: caller + ' is calling ...',
                    room: room,
                    email: caller
                },
                expiresAfter: 60
            }),
            GCM: JSON.stringify({
                data: {
                    message: caller + ' is calling ...',
                    room: room,
                    email: caller
                },
                time_to_live: 60
            })
        };
        notificationTransport.sendMessage(endpointArn, notification, callback);
    };

// Event subscriptions
client.on("error", function(err) {
    console.log("Redis error: " + err);
});


// Endpoint definitions
app.get('/register', function (req, res) {
    console.log("Register Request: " + JSON.stringify(req.query));

    if(req.query.id && req.query.device) {
        notificationTransport.addUser(req.query.device, null, function(err, endpointArn) {
            if(err) {
              console.log("SNS Error:" + err);
              return res.status(500).send('SNS Error');
            }
            client.set(req.query.id, endpointArn, redis.print);
            console.log("Saved '" + req.query.device + "' with endpoint " + endpointArn);
            res.status(200).send('OK');
        });
    }
    else {
        res.status(400).send('Bad Request');
    }

});

app.get('/call', function (req, res) {
    console.log("Call Request: " + JSON.stringify(req.query));

    var caller = decodeId(req.query.caller),
        callee = decodeId(req.query.callee);

    if(!caller.match(emailPattern) || !callee.match(emailPattern)) {
        res.status(400).send('Bad Request');
        return;
    }

    client.get(req.query.callee, function(err, endpointArn){

        var mailCallback = function(err) {
                if(err) {
                    console.log('SES Error: Email could not be delivered to ' + callee + '. ' + err);
                    res.status(500).send('Server Error');
                }
                else {
                    console.log("Sent Email to " + callee);
                    res.status(200).send('OK');
                }
            },
            notificationCallback = function(err, messageId) {
                if(err) {
                  console.log('SNS Error: Notification could not be delivered to ' + endpointArn + '. ' + err);
                  sendEmail(caller, callee, req.query.caller, mailCallback);
                } else {
                  console.log("Sent Notification from " + caller + " to " + endpointArn);
                  res.status(200).send('OK');
                }
            };

        if(endpointArn) {
            sendNotification(caller, endpointArn, req.query.caller, notificationCallback);
        }
        else {
            sendEmail(caller, callee, req.query.caller, mailCallback);
        }
    });

});

// Startup
app.listen(app.get('port'));

console.log('Server envorinment: ' + app.get('env') +
    ' - API listening on port: ' + app.get('port'));
