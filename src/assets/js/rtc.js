/**
 * @author Amir Sanni <amirsanni@gmail.com>
 * @date 6th January, 2020
 */
import h from "./helpers.js";
import EventEmitter from "./emitter.js";
import Presence from "./presence.js";

var TIMEGAP = 6000;
var allUsers = [];
var enableHacks = false;
var meethrix = window.meethrix = false;

var root;
var room;
var username;
var title = "ChatRoom";
var localVideo;

window.addEventListener('DOMContentLoaded', function () {
  room = h.getQString(location.href, "room") ? h.getQString(location.href, "room") : "";
  username = sessionStorage && sessionStorage.getItem("username") ? sessionStorage.getItem("username") : "";
  title = room.replace(/_(.*)/, '');
  localVideo = document.getElementById("local");
  if(title && document.getElementById('chat-title')) document.getElementById('chat-title').innerHTML = title;
  initSocket();
  initRTC();
});

var socket;
var room;
var pc = []; // hold local peerconnection statuses
const pcmap = new Map(); // A map of all peer ids to their peerconnections.
var myStream;
var screenStream;
var mutedStream,
  audioMuted = false,
  videoMuted = false;
var socketId;
var damSocket;
var presence;

function initSocket() {
  var roomPeer = "https://gundb-multiserver.glitch.me/lobby";
  if (room) {
    roomPeer = "https://gundb-multiserver.glitch.me/" + room;
  }

  var peers = [roomPeer];
  var opt = { peers: peers, localStorage: false, radisk: false };
  root = Gun(opt);

  socket = root
    .get("rtcmeeting")
    .get(room)
    .get("socket");

  // Custom Emit Function - move to Emitter?
  socket.emit = function (key, value) {
    if (value.sender && value.to && value.sender == value.to) return;
    console.log("debug emit key", key, "value", value);
    if (!key || !value) return;
    if (!value.ts) value.ts = Date.now();
    // Legacy send through GUN JSON
    if (key == "sdp" || key == "icecandidates") value = JSON.stringify(value);
    socket.get(key).put(value);
  };
}

function sendMsg(msg, local) {
  let data = {
    room: room,
    msg: msg,
    sender: username || socketId
  };

  //emit chat message
  if (!local) socket.emit("chat", data);
  //add localchat
  h.addChat(data, "local");
}

window.onbeforeunload = function () {
  presence.leave();
  pcmap.forEach((pc, id) => {
    if (pcmap.has(id)) {
      pcmap.get(id).close();
      pcmap.delete(id);
    }
  });
};

function initPresence() {
  presence = new Presence(root, room);
  damSocket.__proto__.presence = presence;
  presence.enter();
}

function initRTC() {
  if (!room) {
    document.querySelector("#room-create").attributes.removeNamedItem("hidden");
  } else if (!username) {
    document
      .querySelector("#username-set")
      .attributes.removeNamedItem("hidden");
  } else {
    damSocket = new EventEmitter(root, room);
    initPresence();
    let commElem = document.getElementsByClassName("room-comm");

    for (let i = 0; i < commElem.length; i++) {
      commElem[i].attributes.removeNamedItem("hidden");
    }

    if(localVideo) 
      mutedStream = h.setMutedStream(localVideo);

    document.getElementById("demo").attributes.removeNamedItem("hidden");

    socketId = h.uuidv4();

    console.log("Starting! you are", socketId);

    // Initialize Session
    damSocket.out("subscribe", {
      room: room,
      socketId: socketId,
      name: username || socketId
    });

    //Do we do this here this is now triggered from DAM?
    EventEmitter.prototype.onSubscribe = function (data) {
      console.log("Got channel subscribe", data);
      if (data.ts && Date.now() - data.ts > TIMEGAP * 2) {
        console.log("discarding old sub", data);
        return;
      }
      if (
        pc[data.socketId] !== undefined &&
        pc[data.socketId].connectionState == "connected"
      ) {
        console.log(
          "Existing peer subscribe, discarding...",
          pc[data.socketId]
        );
        return;
      }
      // Ignore self-generated subscribes
      if (data.socketId == socketId || data.sender == socketId) return;
      console.log("got subscribe!", data);

      if (data.to && data.to != socketId) return; // experimental on-to-one reinvite (handle only messages target to us)
      /* discard new user for connected parties? */
      if (
        pc[data.socketId] &&
        pc[data.socketId].iceConnectionState == "connected"
      ) {
        console.log("already connected to peer?", data.socketId);
        //return;
      }
      // New Peer, setup peerConnection
      damSocket.out("newUserStart", {
        to: data.socketId,
        sender: socketId,
        name: data.name || data.socketId
      });
      pc.push(data.socketId);
      init(true, data.socketId);
    };

    EventEmitter.prototype.onNewUserStart = function (data) {
      if (data.ts && Date.now() - data.ts > TIMEGAP) return;
      if (data.socketId == socketId || data.sender == socketId) return;
      if (
        pc[data.socketId] &&
        pc[data.socketId].iceConnectionState == "connected"
      ) {
        console.log("already connected to peer?", data.socketId);
        return; // We don't need another round of Init for existing peers
      }
      pc.push(data.sender);
      init(false, data.sender);
    };

    EventEmitter.prototype.onIceCandidates = function (data) {
      try {
        if (
          (data.ts && Date.now() - data.ts > TIMEGAP) ||
          !data.sender ||
          !data.to
        )
          return;
        console.log(
          data.sender.trim() + " is trying to connect with " + data.to.trim()
        );
        data.candidate = new RTCIceCandidate(data.candidate);
        if (!data.candidate) return;
      } catch (e) {
        console.log(e, data);
        return;
      }
      if (data.socketId == socketId || data.to != socketId) return;
      console.log("ice candidate", data);
      //data.candidate ? pc[data.sender].addIceCandidate(new RTCIceCandidate(data.candidate)) : "";
      data.candidate ? pc[data.sender].addIceCandidate(data.candidate) : "";
    };

    EventEmitter.prototype.onSdp = function (data) {
      try {
        if (data.ts && Date.now() - data.ts > TIMEGAP) return;
        if (
          !data ||
          data.socketId == socketId ||
          data.sender == socketId ||
          !data.description
        )
          return;
        if (data.to !== socketId) {
          console.log("not for us? dropping sdp");
          return;
        }
      } catch (e) {
        console.log(e, data);
        return;
      }

      if (data.description.type === "offer") {
        data.description
          ? pc[data.sender].setRemoteDescription(
              new RTCSessionDescription(data.description)
            )
          : "";

        h.getUserMedia()
          .then(async stream => {
            if(localVideo) localVideo.srcObject = stream;
            
            //save my stream
            myStream = stream;

            stream.getTracks().forEach(track => {
              pc[data.sender].addTrack(track, stream);
            });

            let answer = await pc[data.sender].createAnswer();
            await pc[data.sender].setLocalDescription(answer);

            damSocket.out("sdp", {
              description: pc[data.sender].localDescription,
              to: data.sender,
              sender: socketId
            });
          })
          .catch(async e => {
            console.error(`answer stream error: ${e}`);
            if (!enableHacks) return;
            // start crazy mode lets answer anyhow
            console.log(
              ">>>>>>>>>>>> no media devices! answering receive only"
            );
            var answerConstraints = {
              OfferToReceiveAudio: true,
              OfferToReceiveVideo: true
            };
            let answer = await pc[data.sender].createAnswer(answerConstraints);
            await pc[data.sender].setLocalDescription(answer);

            damSocket.out("sdp", {
              description: pc[data.sender].localDescription,
              to: data.sender,
              sender: socketId
            });
            // end crazy mode
          });
      } else if (data.description.type === "answer") {
        pc[data.sender].setRemoteDescription(
          new RTCSessionDescription(data.description)
        );
      }
    };

    socket.get("chat").on(function (data, key) {
      if (data.ts && Date.now() - data.ts > 5000) return;
      if (data.socketId == socketId || data.sender == socketId) return;
      if (data.sender == username) return;
      console.log("got chat", key, data);
      h.addChat(data, "remote");
    });

    document.getElementById("chat-input").addEventListener("keypress", e => {
      if (e.which === 13 && e.target.value.trim()) {
        e.preventDefault();

        sendMsg(e.target.value);

        setTimeout(() => {
          e.target.value = "";
        }, 50);
      }
    });

    document.getElementById("toggle-video").addEventListener("click", e => {
      e.preventDefault();
      var muted = mutedStream ? mutedStream : h.getMutedStream();
      var mine = myStream ? myStream : muted;
      if (!mine) {
        return; 
      }
      if(!videoMuted){
        h.replaceVideoTrackForPeers(pcmap, muted.getVideoTracks()[0]).then(r=>{
          videoMuted = true;
          localVideo.srcObject = muted;
          e.srcElement.classList.remove("fa-video");
          e.srcElement.classList.add("fa-video-slash");
        });
      } else {
        h.replaceVideoTrackForPeers(pcmap, mine.getVideoTracks()[0]).then(r=>{
          localVideo.srcObject = mine;
          videoMuted = false;
          e.srcElement.classList.add("fa-video");
          e.srcElement.classList.remove("fa-video-slash");
        });
      }

    });

    document.getElementById("toggle-mute").addEventListener("click", e => {
      e.preventDefault();
      var muted = mutedStream ? mutedStream : h.getMutedStream();
      var mine = myStream ? myStream : muted;
      if (!mine) {
        return; 
      }
      //console.log("muted",audioMuted);
      if(!audioMuted){
        h.replaceAudioTrackForPeers(pcmap, muted.getAudioTracks()[0]).then(r=>{
          audioMuted = true;     
          //localVideo.srcObject = muted; // TODO: Show voice muted icon on top of the video or something
          e.srcElement.classList.remove("fa-volume-up");
          e.srcElement.classList.add("fa-volume-mute");
        });
      } else {
        h.replaceAudioTrackForPeers(pcmap, mine.getAudioTracks()[0]).then(r=>{
          audioMuted = false;     
          //localVideo.srcObject = mine; 
          e.srcElement.classList.add("fa-volume-up");
          e.srcElement.classList.remove("fa-volume-mute");
        });
      }


    });

    document.getElementById("toggle-invite").addEventListener("click", e => {
      e.preventDefault();
      //if (!myStream) return;
      console.log("Re-Send presence to all users...");
      var r = confirm("Re-Invite ALL room participants?");
      if (r == true) {
        damSocket.out("subscribe", {
          room: room,
          socketId: socketId,
          name: username || socketId
        });
      }
    });

    document
      .getElementById("toggle-screen")
      .addEventListener("click", async e => {
        e.preventDefault();
        if (screenStream) {
          screenStream.getTracks().forEach(t => {
            t.stop();
            t.onended();
          });
        } else {
          var stream = await h.getDisplayMedia({ audio: true, video: true });
          var atrack = stream.getAudioTracks()[0];
          var vtrack = stream.getVideoTracks()[0];
          if (false) h.replaceAudioTrackForPeers(pcmap, atrack); // TODO: decide somewhere whether to stream audio from DisplayMedia or not
          h.replaceVideoTrackForPeers(pcmap, vtrack);
          document.getElementById("local").srcObject = stream;
          vtrack.onended = function (event) {
            console.log("Screensharing ended via the browser UI");
            screenStream = null;
            if (myStream) {
              document.getElementById("local").srcObject = myStream;
              h.replaceStreamForPeers(pcmap, myStream);
            }
            e.srcElement.classList.remove("sharing");
            e.srcElement.classList.add("text-white");
            e.srcElement.classList.remove("text-black");
          };
          screenStream = stream;
          e.srcElement.classList.add("sharing");
          e.srcElement.classList.remove("text-white");
          e.srcElement.classList.add("text-black");
        }
      });

      document.getElementById("private-toggle").addEventListener("click", e => {
        e.preventDefault();
        // Detect if we are already in private mode
        let keys = Object.keys(presence.root._.opt.peers);
        if(keys.length == 0) {
          //if in private mode, go public
          presence.onGrid(presence.room);
          e.srcElement.classList.remove("fa-lock");
          e.srcElement.classList.add("fa-unlock");
        } else {
          //if public, go private
          presence.offGrid();
          e.srcElement.classList.remove("fa-unlock");
          e.srcElement.classList.add("fa-lock");
        }
      });
  }
}

function init(createOffer, partnerName) {
  // OLD: track peerconnections in array
  if(pcmap.has(partnerName)) return pcmap.get(partnerName);
  pc[partnerName] = new RTCPeerConnection(h.getIceServer());
  // DAM: replace with local map keeping tack of users/peerconnections
  pcmap.set(partnerName, pc[partnerName]); // MAP Tracking
  h.addVideo(partnerName,false);
  // Q&A: Should we use the existing myStream when available? Potential cause of issue and no-mute
  if (screenStream) {
    var tracks ={}; 
    tracks['audio'] = screenStream.getAudioTracks();
    tracks['video'] = screenStream.getVideoTracks(); 
    if (myStream) {
      tracks['audio'] = myStream.getAudioTracks(); //We want sounds from myStream if there is such
      if (!tracks.video.length) tracks['video'] = myStream.getVideoTracks(); //also if our screenStream is malformed, let's default to myStream in that case
    }
    ['audio', 'video'].map(tracklist => {
      tracks[tracklist].forEach(track => {
        pc[partnerName].addTrack(track, screenStream); //should trigger negotiationneeded event
      });
    });
  } else if (!screenStream && myStream) {
    var tracks ={}; 
    tracks['audio'] = myStream.getAudioTracks();
    tracks['video'] = myStream.getVideoTracks(); 
    if(audioMuted || videoMuted){ 
      var mutedStream = mutedStream ? mutedStream : h.getMutedStream();
      if(videoMuted) tracks['video'] = mutedStream.getVideoTracks();
      if(audioMuted) tracks['audio'] = mutedStream.getAudioTracks();
    } 
    ['audio','video'].map(tracklist=>{
      tracks[tracklist].forEach(track => {
        pc[partnerName].addTrack(track, myStream); //should trigger negotiationneeded event
      });
    });
  } else {
    h.getUserMedia()
      .then(stream => {
        //save my stream
        myStream = stream;
        //provide access to window for debug
        var mixstream = new MediaStream();
        window.myStream = myStream;
        window.mixstream = mixstream;
        var tracks ={}; 
        tracks['audio'] = myStream.getAudioTracks();
        tracks['video'] = myStream.getVideoTracks(); 
        if(audioMuted || videoMuted){ 
          var mutedStream = mutedStream ? mutedStream : h.getMutedStream();
          if(videoMuted) tracks['video'] = mutedStream.getVideoTracks();
          if(audioMuted) tracks['audio'] = mutedStream.getAudioTracks();
        } 
        ['audio','video'].map(tracklist=>{
          tracks[tracklist].forEach(track => {
            pc[partnerName].addTrack(track, mixstream); //should trigger negotiationneeded event
          });
        });

        if(!localVideo.srcObject) localVideo.srcObject = mixstream;
      })
      .catch(async e => {
        console.error(`stream error: ${e}`);
        if (!enableHacks) return;
        // start crazy mode - lets offer anyway
        console.log(">>>>>>>>>>>> no media devices! offering receive only");
        var offerConstraints = {
          mandatory: { OfferToReceiveAudio: true, OfferToReceiveVideo: true }
        };
        let offer = await pc[partnerName].createOffer(offerConstraints);
        await pc[partnerName].setLocalDescription(offer);
        damSocket.out("sdp", {
          description: pc[partnerName].localDescription,
          to: partnerName,
          sender: socketId
        });
        // end crazy mode
      });
  }

  //create offer
  if (createOffer) {
    pc[partnerName].onnegotiationneeded = async () => {
      try {
        if (pc[partnerName].isNegotiating) {
          console.log(
            "negotiation needed with existing state?",
            partnerName,
            pc[partnerName].isNegotiating,
            pc[partnerName].signalingState
          );
          return; // Chrome nested negotiation bug
        }
        pc[partnerName].isNegotiating = true;
        let offer = await pc[partnerName].createOffer();
        await pc[partnerName].setLocalDescription(offer);
        damSocket.out("sdp", {
          description: pc[partnerName].localDescription,
          to: partnerName,
          sender: socketId
        });
      } finally {
        pc[partnerName].isNegotiating = false;
      }
    };
  }

  //send ice candidate to partnerNames
  pc[partnerName].onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    damSocket.out("icecandidates", {
      candidate: candidate,
      to: partnerName,
      sender: socketId
    });
  };

   //add
   pc[partnerName].ontrack = e => {
    let str = e.streams[0];
    var el = document.getElementById(`${partnerName}-video`);
    if (el) {
      el.srcObject = str;
    } else {
      h.addVideo(partnerName, str);
    }
  };

  pc[partnerName].onconnectionstatechange = d => {
    console.log(
      "Connection State Change: " + partnerName,
      pc[partnerName].iceConnectionState
    );
    // Save State
    switch (pc[partnerName].iceConnectionState) {
      case "connected":
        sendMsg(
          partnerName + " is " + pc[partnerName].iceConnectionState,
          true
        );
        break;
      case "disconnected":
        if (partnerName == socketId) {
          return;
        }
        sendMsg(
          partnerName + " is " + pc[partnerName].iceConnectionState,
          true
        );
        h.closeVideo(partnerName);
        // PC Tracking cleanup
        pcmap.get(partnerName).close();
        pcmap.delete(partnerName);
        break;
      case "new":
        /* why is new objserved when certain clients are disconnecting? */
        //h.closeVideo(partnerName);
        break;
      case "failed":
        if (partnerName == socketId) {
          return;
        } // retry catch needed
        //h.closeVideo(partnerName);
        break;
      case "closed":
        h.closeVideo(partnerName);
        break;
      default:
        console.log("Change of state: ", pc[partnerName].iceConnectionState);
        break;
    }
  };

  pc[partnerName].onsignalingstatechange = d => {
    console.log(
      "Signaling State Change: " + partnerName,
      pc[partnerName].signalingState
    );
    switch (pc[partnerName].signalingState) {
      case "stable":
        pc[partnerName].isNegotiating = false;
        break;
      case "closed":
        console.log("Signalling state is 'closed'");
        // Peers go down here and there - let's send a Subscribe, Just in case...
        damSocket.out("subscribe", {
          room: room,
          socketId: socketId,
          name: username || socketId
        });

        //h.closeVideo(partnerName);
        break;
    }
  };
}
