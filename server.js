var express = require('express'),
    crypto = require('crypto-js'),
    cors = require('cors'),
    XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

    app = exports.app = express();

app.set('port', process.env.PORT || 8001)
    .set('env', process.env.NODE_ENV || 'local');

app.use(cors());



app.get('/authorize', function (req, res) {



});



app.listen(app.get('port'));

console.log('Get a room Server ' + app.get('env') +
    ' API listening on port ' + app.get('port'));
