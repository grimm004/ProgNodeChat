"use strict";

const forceOnlineFirebase = true;
var environment = process.env.NODE_ENV || 'development';
var express = require("express");
if (environment === "production" || forceOnlineFirebase) {
    var firebase = require("firebase");
    var firebaseConfig = require("./config_firebase");
    firebase.initializeApp(firebaseConfig);
} else {
    var firebase = new require("firebase-mock").Mock();
}

class ChatApplication {
    constructor(port, public_folder = "public") {
        this._port = port;

        this._app = express();
        this._app.use(express.static(public_folder, { extensions: ['html', 'htm'], }));
        this._app.use(express.json());

        this._app.post("/login", (req, res) => {
            console.log("Login Requested");
            firebase.auth().signInWithEmailAndPassword(req.body.email, req.body.password)
            .then(function(user) {
                console.log("Success...");
                res.json({ loggedIn: true, errorCode: "", uid: user.user.uid });
            })
            .catch(function(error) {
                var errorCode = error.code;
                var errorMessage = error.message;
                console.log("Error logging in: " + errorCode + ", " + errorMessage);
                res.json({ loggedIn: false, errorCode: errorCode, uid: "" });
            });
        });

        this._app.post("/register", (req, res) => {
            console.log("Register Request: " + req.body.email);

            firebase.auth().createUserWithEmailAndPassword(req.body.email, req.body.password)
            .then(function(user) {
                console.log("Success...");
                res.json({ registered: true, errorCode: "", uid: user.user.uid });
            })
            .catch(function(error) {
                var errorCode = error.code;
                var errorMessage = error.message;
                console.log("Error registering: " + errorCode + ", " + errorMessage);
                res.json({ registered: false, errorCode: errorCode, uid: "" });
            });
        });

        this._app.post("/status", (req, res) => {
            console.log("Status Request...");
            var user = firebase.auth().currentUser;
            res.json({ loggedIn: user != null });
        });

        this._app.post("/logout", (req, res) => {
            console.log("Logout Request...");
            firebase.auth().signOut()
            .then(function() {
                
            })
            .catch(function(error) {
                console.log(error);
            });
            res.status(200).json({ });
        });
    }

    get Port() {
        return this._port;
    }

    start() {
        this._app.listen(this._port);
    }
}

module.exports = ChatApplication;