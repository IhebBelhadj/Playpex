'use strict';

// Request limits per plugin and host (docs/plugins-plan.md §4.2): a token
// bucket (perSecond, burst) plus at most `inFlight` requests at once. Over
// the limit a request waits its turn, in order; past maxWaitMs it fails with
// RATE_LIMITED. A plugin hammering a site would get the user's address banned.
//
//   limiter.acquire(key, { perSecond, burst, inFlight, maxWaitMs }) → Promise<release()>

function RateLimiter() {
  this.buckets = new Map();
}

RateLimiter.prototype.bucket = function (key, rules) {
  var b = this.buckets.get(key);
  if (!b) {
    b = { tokens: rules.burst, at: Date.now(), inFlight: 0, waiting: [], timer: null, rules: rules };
    this.buckets.set(key, b);
  }
  b.rules = rules;
  return b;
};

function refill(b) {
  var now = Date.now();
  b.tokens = Math.min(b.rules.burst, b.tokens + (now - b.at) / 1000 * b.rules.perSecond);
  b.at = now;
}

RateLimiter.prototype.acquire = function (key, rules) {
  var self = this, b = this.bucket(key, rules);
  return new Promise(function (resolve, reject) {
    var waiter = { resolve: resolve, reject: reject, timer: null };
    waiter.timer = setTimeout(function () {
      b.waiting = b.waiting.filter(function (w) { return w !== waiter; });
      var err = new Error('rate limited: more than ' + rules.perSecond + ' requests/s to this host');
      err.code = 'RATE_LIMITED';
      reject(err);
    }, rules.maxWaitMs);
    b.waiting.push(waiter);
    self.drain(key, b);
  });
};

RateLimiter.prototype.drain = function (key, b) {
  var self = this;
  refill(b);
  while (b.waiting.length && b.tokens >= 1 && b.inFlight < b.rules.inFlight) {
    var w = b.waiting.shift();
    clearTimeout(w.timer);
    b.tokens -= 1;
    b.inFlight++;
    w.resolve(this.releaser(key, b));
  }
  if (b.waiting.length && !b.timer && b.inFlight < b.rules.inFlight) {
    // the next token
    b.timer = setTimeout(function () {
      b.timer = null;
      self.drain(key, b);
    }, Math.max(5, Math.ceil((1 - b.tokens) / b.rules.perSecond * 1000)));
  }
  if (!b.waiting.length && !b.inFlight && b.tokens >= b.rules.burst) {
    this.buckets.delete(key);
  }
};

RateLimiter.prototype.releaser = function (key, b) {
  var self = this, released = false;
  return function release() {
    if (!released) {
      released = true;
      b.inFlight--;
      self.drain(key, b);
    }
  };
};

RateLimiter.prototype.reset = function () {
  this.buckets.forEach(function (b) {
    clearTimeout(b.timer);
    b.waiting.forEach(function (w) { clearTimeout(w.timer); });
  });
  this.buckets.clear();
};

module.exports = RateLimiter;
