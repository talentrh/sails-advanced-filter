const Find = require('./lib/Find');

module.exports = {
  find(req) {
    return new Find(req);
  }
}
