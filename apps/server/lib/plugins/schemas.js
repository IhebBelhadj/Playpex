'use strict';

// Validators of the plugin contract (@playpex/protocol: plugin.schema.json,
// plugin-api.schema.json, repository.schema.json), compiled once. The host
// checks every manifest with them and every answer a plugin gives before using
// it: an answer out of schema counts as the handler failing.

var Ajv2020 = require('ajv/dist/2020'),
  protocol = require('@playpex/protocol/plugins'),
  manifestSchema = require('@playpex/protocol/plugin.schema.json'),
  apiSchema = require('@playpex/protocol/plugin-api.schema.json'),
  repositorySchema = require('@playpex/protocol/repository.schema.json');

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(apiSchema);
ajv.addSchema(manifestSchema);
ajv.addSchema(repositorySchema);

var cache = {};

function validator(ref) {
  if (!cache[ref]) {
    var v = ajv.getSchema(ref);
    if (!v) {
      throw new Error('no schema ' + ref);
    }
    cache[ref] = v;
  }
  return cache[ref];
}

function messages(v) {
  return (v.errors || []).slice(0, 5).map(function (e) { return (e.instancePath || '/') + ' ' + e.message; });
}

/** Problems of a manifest: the schema's, then checkManifest's; [] when it's fine */
function manifestProblems(manifest, options) {
  var v = validator(manifestSchema.$id);
  if (!v(manifest)) {
    return messages(v);
  }
  return protocol.checkManifest(manifest, options).map(function (p) { return p.path + ' ' + p.message; });
}

/** null when `value` matches $defs/<def> of plugin-api.schema.json, else why not */
function apiProblem(def, value) {
  var v = validator(apiSchema.$id + '#/$defs/' + def);
  return v(value) ? null : messages(v).join('; ');
}

function hookProblem(name, side, value) {
  return apiProblem('hooks/' + name + '/' + side, value);
}

function indexProblems(index) {
  var v = validator(repositorySchema.$id);
  return v(index) ? [] : messages(v);
}

module.exports = {
  manifestProblems: manifestProblems,
  apiProblem: apiProblem,
  hookProblem: hookProblem,
  indexProblems: indexProblems
};
