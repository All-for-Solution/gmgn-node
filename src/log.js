function log(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`${stamp} [gmgn-node] ${message}`);
}

module.exports = { log };
