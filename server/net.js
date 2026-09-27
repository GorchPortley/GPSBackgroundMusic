import { networkInterfaces } from 'node:os';

/**
 * Every usable IPv4 address this machine has on the local network.
 *
 * Used twice: to list addresses in the certificate's SAN field, and to print
 * the URLs you can reach the server on from a phone.
 */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // link-local, unroutable
      out.push({ name, address: addr.address });
    }
  }
  // Ordinary LAN ranges first — those are the ones a phone on the same Wi-Fi
  // can actually reach; virtual adapters (WSL, Hyper-V) sort to the bottom.
  return out.sort((a, b) => rank(a) - rank(b));
}

function rank({ name, address }) {
  const virtual = /vethernet|virtualbox|vmware|docker|loopback/i.test(name);
  if (virtual) return 3;
  if (address.startsWith('192.168.') || address.startsWith('10.')) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 1;
}
