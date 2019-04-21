/* eslint-env node */
/* eslint-disable no-console */
"use strict";

const express = require("express");
const http = require("http");
const socketio = require("socket.io");

const app = express();
const httpServer = http.Server(app);
const io = socketio(httpServer);

function initialiseApp(firebaseAdmin) {
    app.use(express.json());
    app.use(firebaseAdmin.middleware);
    app.use(express.static("public", { extensions: ["html", "htm", "ico", "png"], }));
    
    var auth = firebaseAdmin.auth();
    var db = firebaseAdmin.database();

    function verifyIdToken(idToken, successCallback, errorCallback) {
        auth.verifyIdToken(idToken)
            .then(successCallback)
            .catch(errorCallback);
    }

    function getUserByEmail(email, successCallback, errorCallback) {
        auth.getUserByEmail(email)
            .then(successCallback)
            .catch(errorCallback);
    }

    function getUser(uid, successCallback, errorCallback) {
        auth.getUser(uid)
            .then(successCallback)
            .catch(errorCallback);
    }

    app.post("/addcontact",
        (req, res) =>
            // Decode the client's login token to access its user object
            verifyIdToken(req.body.idToken,
                sender =>
                    // Decode the target contact's email to access its user object
                    getUserByEmail(req.body.contactEmail,
                        target => {
                            console.log(target);
                            // Check the two users are not already contacts
                            db.ref(`user/${target.uid}/contacts/${sender.uid}`).once("value", snapshot => {
                                // If they are not already contacts, continue to next check
                                if (!snapshot.val())
                                    // Check if the target contact has already sent a contact request to the sender
                                    db.ref(`user/${sender.uid}/contactRequests/${target.uid}`).once("value", snapshot => {
                                        // If there is an outstanding contact request, add the two as contacts
                                        if (snapshot.val()) {
                                            addAsContacts(sender, target);
                                            res.json({ success: true, code: "contact-added" });
                                        }
                                        // Else check if the target user uid already exists as a key (the sender has already sent a contact request)
                                        else db.ref(`user/${target.uid}/contactRequests/${sender.uid}`).once("value", snapshot => {
                                            // If it does not exist, add it as a key with its data being a timestamp
                                            if (!snapshot.val()) {
                                                db.ref(`user/${target.uid}/contactRequests/${sender.uid}`).set({ email: sender.email, timestamp: Date.now() });
                                                res.json({ success: true, code: "request-sent" });
                                            } else res.json({ success: false, code: "request-already-sent" });
                                        });
                                    });
                                // If the two users are contacts, return a message to say they are
                                else res.json({ success: false, code: "already-contacts" });
                            });
                        },
                        error => {
                            console.log("Error fetching user data:", error);
                            res.json({ success: false, code: error.errorInfo ? error.errorInfo.code : "unknown" });
                        }
                    ),
                error => {
                    console.log("Error occurred authenticating contact add request: ", error);
                    res.json({ success: false, code: "unknown" });
                }
            )
    );

    app.post("/acceptcontact",
        (req, res) =>
            verifyIdToken(req.body.idToken,
                decodedToken =>
                    getUser(req.body.contact,
                        user => {
                            addAsContacts(decodedToken, user);
                            res.json({ success: true, code: "" });
                        },
                        error => {
                            console.log("Error fetching user data:", error);
                            res.json({ success: false, code: error });
                        }
                    ),
                error => {
                    console.log("Error occurred authenticating contact accept request: ", error);
                    res.json({ success: false, code: "unknown" });
                }
            )
    );

    app.post("/messages",
        (req, res) => {
            verifyIdToken(req.body.idToken,
                decodedToken => {
                    db.ref(`user/${decodedToken.uid}/contacts/${req.body.contact}`).once("value",
                        targetContactSnapshot => {
                            var contactInfo = targetContactSnapshot.val();
                            if (contactInfo)
                                db.ref(`conversation/${contactInfo.conversationId}/messages`).once("value",
                                    messageListSnapshot => {
                                        var allMessages = [];
                                        messageListSnapshot.forEach(messageSnapshot => { allMessages.push(messageSnapshot.val()); });
                                        res.json({ success: true, messages: allMessages });
                                    });
                        });
                }, error => console.log(error));
        });

    function addAsContacts(contact0, contact1) {
        var timestamp = Date.now();
        // Create conversation node for contacts
        var conversationId = db.ref("conversation").push({ created: timestamp }).key;
        // Add users as contacts
        db.ref(`user/${contact1.uid}/contacts/${contact0.uid}`).set({ timestamp: timestamp, conversationId: conversationId, recentMessage: "", recentMessageTimestamp: timestamp, recentMessageViewed: false });
        db.ref(`user/${contact0.uid}/contacts/${contact1.uid}`).set({ timestamp: timestamp, conversationId: conversationId, recentMessage: "", recentMessageTimestamp: timestamp, recentMessageViewed: false });
        // Remove any contact request information
        db.ref(`user/${contact1.uid}/contactRequests/${contact0.uid}`).remove();
        db.ref(`user/${contact0.uid}/contactRequests/${contact1.uid}`).remove();
    }

    io.on("connection",
        socket => {
            socket["uid"] = "";
            socket["typing"] = false;
            socket["contacts"] = [];
            socket["contactsRef"] = null;
            socket.on("auth",
                data => {
                    verifyIdToken(data.idToken,
                        user => {
                            socket.uid = user.uid;
                            socket.contactsRef = db.ref(`user/${socket.uid}/contacts`);
                            socket.contactsRef.on("value", contactsSnapshot => {
                                socket.contacts = [];
                                contactsSnapshot.forEach(contactSnapshot => socket.contacts.push(contactSnapshot.key));
                            });
                        }, error => console.log(error));
                });
            socket.on("message",
                data =>
                    verifyIdToken(data.idToken,
                        sender =>
                            getUser(data.targetUid,
                                target =>
                                    db.ref(`user/${sender.uid}/contacts/${target.uid}/conversationId`).once("value",
                                        conversationId => {
                                            var messageData = { text: data.text, senderUid: sender.uid, timestamp: data.timestamp };
                                            db.ref(`conversation/${conversationId.val()}/messages`).push(messageData);
                                            var contactUpdate = { recentMessage: data.text, recentMessageTimestamp: data.timestamp, recentMessageViewed: false };
                                            db.ref(`user/${sender.uid}/contacts/${target.uid}`).update(contactUpdate);
                                            db.ref(`user/${target.uid}/contacts/${sender.uid}`).update(contactUpdate);
                                            forEachSocket(clientSocket => { if (clientSocket.uid == target.uid) clientSocket.emit("message", messageData); });
                                        }),
                                error => {
                                    console.log(error);
                                }),
                        error => {
                            console.log(error);
                        })
            );

            socket.on("disconnect", () => {
                forEachSocket(clientSocket => { if (socket.contacts.indexOf(clientSocket.uid) > -1) clientSocket.emit("untyping", { senderUid: socket.uid }); });
                if (socket.contactsRef) socket.contactsRef.off();
            });

            socket.on("typing",
                data => verifyIdToken(data.idToken,
                    sender => forEachSocket(clientSocket => { if (clientSocket.uid == data.targetUid) clientSocket.emit("typing", { senderUid: sender.uid }); }),
                    error => console.log(error))
            );

            socket.on("untyping",
                data => verifyIdToken(data.idToken,
                    sender => forEachSocket(clientSocket => { if (clientSocket.uid == data.targetUid) clientSocket.emit("untyping", { senderUid: sender.uid }); }),
                    error => console.log(error))
            );
        }
    );

    function forEachSocket(callback) {
        Object.keys(io.sockets.sockets).forEach(socketId => callback(io.sockets.sockets[socketId]));
    }
}

module.exports = {
    expressApp: app,
    initialiseApp: initialiseApp,
    httpServer: httpServer,
    socketIOApp: io,
};
