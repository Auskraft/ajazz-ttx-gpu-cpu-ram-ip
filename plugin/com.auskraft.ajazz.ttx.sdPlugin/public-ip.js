'use strict';

const { isIP, isIPv4 } = require('node:net');

const requestTimeout = 3500;
const minRequestInterval = 4500;

function parseAddress(body) {
  const address = body.trim();
  return isIPv4(address) ? { address, country: null } : null;
}

function parseTrace(body) {
  const address = body.match(/^ip=([^\r\n]+)$/m)?.[1]?.trim();
  if (!address || !isIP(address)) return null;
  const code = body.match(/^loc=([^\r\n]+)$/m)?.[1]?.trim().toUpperCase();
  const country = code && /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : null;
  return { address, country };
}

function createLookup(url, parse) {
  let pending = null;
  let checkedAt = -Infinity;
  let cached = null;

  function read(now) {
    if (pending) return pending.result;
    if (now - checkedAt < minRequestInterval) return Promise.resolve(cached);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeout);
    const job = { controller };
    checkedAt = now;
    pending = job;
    job.result = fetch(url, { signal: controller.signal, redirect: 'error' })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.text();
        return body.length <= 4096 ? parse(body) : null;
      })
      .catch(() => null)
      .then((reading) => {
        if (pending === job) cached = reading;
        return reading;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (pending === job) pending = null;
      });
    return job.result;
  }

  function cancel() {
    if (!pending) return;
    const { controller } = pending;
    pending = null;
    checkedAt = -Infinity;
    cached = null;
    controller.abort();
  }

  return { read, cancel };
}

function createPublicIpLookups() {
  return {
    address: createLookup('https://api.ipify.org', parseAddress),
    location: createLookup('https://www.cloudflare.com/cdn-cgi/trace', parseTrace)
  };
}

module.exports = { createPublicIpLookups };
