"use strict";
// E3 E-SIGN - the CRYPTOGRAPHIC seal (David, Nov 1 2026: one E3 certificate seals the reports
// of every tenant). Adds an Adobe-compatible digital signature (adbe.pkcs7.detached, RSA /
// SHA-256) over the finished PDF, so Acrobat shows "Signed and all signatures are valid" and
// flags any change made after signing.
//
// App Service settings - pick ONE certificate source:
//
//   A) Azure Key Vault (recommended; the private key never leaves the vault / HSM)
//        ESIGN_KV_KEY_ID     full key id, e.g. https://e3-sign.vault.azure.net/keys/e3-docsign/<version>
//        ESIGN_CERT_PEM      the issued certificate + intermediate chain (PEM, all in one value,
//                            or base64 of the PEM).  Auth: the App Service managed identity
//                            (DefaultAzureCredential) needs the Key Vault "Crypto User" role.
//
//   B) Certificate file (.pfx / .p12)
//        ESIGN_P12_BASE64    the .pfx file, base64
//        ESIGN_P12_PASSWORD  its password
//
//   Optional:
//        ESIGN_TSA_URL       RFC 3161 time-stamp server (e.g. http://ts.ssl.com). Adds a trusted
//                            signing time so the date cannot be set from a wrong clock. When the
//                            server cannot be reached the signature is still made (logged).
//
// With neither A nor B set, E3 signs in TEST MODE: a temporary self-signed certificate,
// a red "TEST SIGNATURE" mark on every page it touches, and nothing is released to clients.
const crypto = require("crypto");
const forge = require("node-forge");

const SIG_LENGTH = 16384; // bytes reserved in the PDF for the CMS (cert chain + time-stamp)

function pemFromEnv(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/-----BEGIN/.test(s)) return s.replace(/\\n/g, "\n");
  try { return Buffer.from(s, "base64").toString("utf8"); } catch (e) { return ""; }
}

let cached = null; // { mode, certs: [forge cert], key?: forge key, kvKeyId?, label, test }
let testIdentity = null;

function makeTestIdentity() {
  if (testIdentity) return testIdentity;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [
    { name: "commonName", value: "E3 TEST CERTIFICATE - NOT TRUSTED" },
    { name: "organizationName", value: "E3 Inspection Reporting Solutions" },
    { name: "countryName", value: "US" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  testIdentity = { mode: "test", certs: [cert], key: keys.privateKey, test: true };
  return testIdentity;
}

function certLabel(cert, test) {
  const cn = (cert.subject.getField("CN") || {}).value || "";
  const o = (cert.subject.getField("O") || {}).value || "";
  const issuer = (cert.issuer.getField("O") || cert.issuer.getField("CN") || {}).value || "";
  if (test) return "E3 TEST CERTIFICATE (self-signed, not trusted) - for testing only";
  return [cn || o, issuer ? "issued by " + issuer : ""].filter(Boolean).join(" · ");
}

// The certificate in use. Never throws for "not configured" - that is TEST mode.
function identity() {
  if (cached) return cached;
  const kvId = String(process.env.ESIGN_KV_KEY_ID || "").trim();
  const p12 = String(process.env.ESIGN_P12_BASE64 || "").trim();
  if (kvId) {
    const pem = pemFromEnv(process.env.ESIGN_CERT_PEM);
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (!blocks.length) throw new Error("ESIGN_CERT_PEM is missing or has no certificate.");
    const certs = blocks.map((b) => forge.pki.certificateFromPem(b));
    cached = { mode: "keyvault", certs, kvKeyId: kvId, test: false };
  } else if (p12) {
    const der = forge.util.decode64(p12);
    const pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), String(process.env.ESIGN_P12_PASSWORD || ""));
    const keyBag = (pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]
      || (pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
    const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    if (!keyBag || !certBags.length) throw new Error("The .pfx has no private key or certificate.");
    const key = keyBag.key;
    // signer certificate first: the one whose public key matches the private key
    const certs = certBags.map((b) => b.cert);
    certs.sort((a, b) => (a.publicKey.n && a.publicKey.n.equals(key.n) ? -1 : 0) - (b.publicKey.n && b.publicKey.n.equals(key.n) ? -1 : 0));
    cached = { mode: "p12", certs, key, test: false };
  } else {
    cached = makeTestIdentity();
  }
  cached.label = certLabel(cached.certs[0], cached.test);
  cached.subject = (cached.certs[0].subject.getField("CN") || {}).value || "";
  cached.serial = cached.certs[0].serialNumber;
  return cached;
}
function status() {
  try {
    const id = identity();
    return { configured: !id.test, mode: id.mode, test: !!id.test, certificate: id.label, notAfter: id.certs[0].validity.notAfter.toISOString() };
  } catch (e) {
    return { configured: false, mode: "error", test: false, error: e.message };
  }
}

// ---------------------------------------------------------------- RFC 3161 time-stamp
async function timestampToken(signatureBytes) {
  const url = String(process.env.ESIGN_TSA_URL || "").trim();
  if (!url) return null;
  const asn1 = forge.asn1;
  const hash = crypto.createHash("sha256").update(Buffer.from(signatureBytes, "binary")).digest();
  const nonce = crypto.randomBytes(8);
  nonce[0] &= 0x7f;
  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hash.toString("binary")),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, nonce.toString("binary")),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ]);
  const body = Buffer.from(asn1.toDer(req).getBytes(), "binary");
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error("time-stamp server answered " + resp.status);
  const der = Buffer.from(await resp.arrayBuffer());
  const tsResp = asn1.fromDer(der.toString("binary"));
  const st = tsResp.value[0];
  const code = st && st.value[0] ? forge.util.bytesToHex(st.value[0].value) : "";
  if (parseInt(code || "ff", 16) > 1) throw new Error("time-stamp refused (status " + code + ")");
  if (!tsResp.value[1]) throw new Error("time-stamp response has no token");
  return tsResp.value[1]; // TimeStampToken (a ContentInfo)
}

// ---------------------------------------------------------------- CMS
// Builds the detached PKCS#7 for the bytes covered by the PDF's ByteRange.
async function cmsFor(content, signingTime) {
  const id = identity();
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content.toString("binary"));
  for (const c of id.certs) p7.addCertificate(c);
  let digestToSign = null;
  // Key Vault: forge needs a key object - this one only records what must be signed.
  const key = id.mode === "keyvault"
    ? { sign: (md) => { digestToSign = Buffer.from(md.digest().getBytes(), "binary"); return "\0".repeat(256); } }
    : id.key;
  p7.addSigner({
    key, certificate: id.certs[0], digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signingTime || new Date() },
    ],
  });
  p7.sign({ detached: true });
  if (id.mode === "keyvault") {
    const { CryptographyClient } = require("@azure/keyvault-keys");
    const { DefaultAzureCredential } = require("@azure/identity");
    const client = new CryptographyClient(id.kvKeyId, new DefaultAzureCredential());
    const r = await client.sign("RS256", digestToSign);
    p7.signers[0].signature = Buffer.from(r.result).toString("binary");
  }
  const asn = p7.toAsn1();
  // optional trusted time-stamp -> unsigned attribute on the SignerInfo
  try {
    const token = await timestampToken(p7.signers[0].signature);
    if (token) {
      const asn1 = forge.asn1;
      const signedData = asn.value[1].value[0];
      const signerInfos = signedData.value[signedData.value.length - 1];
      const si = signerInfos.value[0];
      si.value.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer("1.2.840.113549.1.9.16.2.14").getBytes()),
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [token]),
        ]),
      ]));
    }
  } catch (e) {
    console.error("esign time-stamp skipped:", e && e.message);
  }
  return Buffer.from(forge.asn1.toDer(asn).getBytes(), "binary");
}

class E3Signer extends require("@signpdf/utils").Signer {
  async sign(pdfBuffer, signingTime) { return cmsFor(pdfBuffer, signingTime); }
}

// doc: a pdf-lib PDFDocument with the visible stamp already drawn.
async function sealPdf(doc, { reason, location, contactInfo, name, signedAt }) {
  const { pdflibAddPlaceholder } = require("@signpdf/placeholder-pdf-lib");
  const { SignPdf } = require("@signpdf/signpdf");
  pdflibAddPlaceholder({
    pdfDoc: doc, reason, contactInfo: contactInfo || "", name: name || "", location: location || "",
    signatureLength: SIG_LENGTH, appName: "E3 E-Sign", signingTime: signedAt ? new Date(signedAt) : new Date(),
  });
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signer = new E3Signer();
  const signed = await new SignPdf().sign(bytes, signer, signedAt ? new Date(signedAt) : new Date());
  return Buffer.from(signed);
}

module.exports = { sealPdf, status, identity, cmsFor, _reset: () => { cached = null; } };
