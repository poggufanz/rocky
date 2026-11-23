const api = {};
api["parse"] = function parse(input) {
  return String(input).trim().split(",");
};
Object.assign(module.exports, api);
const exportName = "parse";
module.exports[exportName] = api.parse;
