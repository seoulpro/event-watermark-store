"use strict";

const isWellFormedUnicode = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const requireWellFormedUnicode = (value, label) => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (!isWellFormedUnicode(value)) {
    throw new TypeError(`${label} must contain well-formed Unicode`);
  }
  return value;
};

const requireKey = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("key must be a non-empty string");
  }
  return requireWellFormedUnicode(value, "key");
};

module.exports = {
  isWellFormedUnicode,
  requireKey,
  requireWellFormedUnicode,
};
