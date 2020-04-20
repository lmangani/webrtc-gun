var peers = [
  "https://gundb-multiserver.glitch.me/lobby"
];
var opt = { peers: peers, localStorage: false, radisk: false };
var root = Gun(opt);

const pid = root._.opt.pid;
const users = new Map();

window.onunload = leave;
document.addEventListener("DOMContentLoaded", enter);
const presenceTimer = setInterval(() => distrubutePresence(), 500);

root.on("in", function (msg) {
  if (msg && msg.event) {
    // Handle Global event: ALL peers will receive this!
    switch (msg.event) {
      case "enter":
        users.set(msg.pid, msg);
        addItem(msg.pid);
        break;
      case "leave":
        users.delete(msg.pid);
        removeItem(msg.pid);
        break;
      case "presence":
        addReceivedUsers(msg.data);
        break;
      default:
        console.log(msg);
    }
  }
});

function addReceivedUsers(data) {
  const receivedUsers = new Map(JSON.parse(data));
  receivedUsers.forEach(function (value, key) {
    if (!users.has(key)) {
      users.set(key, value);
      addItem(key);
    }
  });
}

function send(event, data) {
  root.on("out", { pid: pid, event: event, data: data });
}


function enter() {
  send("enter", null);
  users.set(pid, null);
  addItem(pid);
}

function leave() {
  send("leave", null);
  clearInterval(presenceTimer);
}

function distrubutePresence() {
  send("presence", JSON.stringify([...users]));
}

function addItem(pid) {
  var ul = document.getElementById("dynamic-list");

  var li = document.createElement("li");
  li.setAttribute("id", pid);
  li.appendChild(document.createTextNode(pid));
  ul.appendChild(li);
}

function removeItem(pid) {
  var ul = document.getElementById("dynamic-list");

  var item = document.getElementById(pid);
  ul.removeChild(item);
}

function offGrid() {
  const keys = Object.keys(root._.opt.peers)
  for (const key of keys) {
    var peer = root._.opt.peers[key];
    peer.enabled = false;
    root.on('bye', peer);
    peer.url = '';
  }
}

function onGrid(peer) {
  root.opt({ peers: [peer] })
}
