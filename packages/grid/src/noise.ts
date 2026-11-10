import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
} from "node:crypto";

import type { KeyObject } from "node:crypto";

/* Noise_IK_25519_ChaChaPoly_SHA256 (spec §1): the name is exactly 32 bytes, so it is the first hash as is. */
const PROTOCOL: Buffer = Buffer.from("Noise_IK_25519_ChaChaPoly_SHA256", "ascii");
const PRIVATE_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const PUBLIC_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const TAG_LENGTH = 16;
const EMPTY: Buffer = Buffer.alloc(0);

export interface Keypair {
    private: Buffer;
    public: Buffer;
}

function privateKeyObject(raw: Buffer): KeyObject {
    return createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function publicKeyObject(raw: Buffer): KeyObject {
    return createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, raw]), format: "der", type: "spki" });
}

export function keypairOf(privateKey: Buffer): Keypair {
    const exported = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });

    return { private: privateKey, public: Buffer.from(exported.subarray(PUBLIC_PREFIX.length)) };
}

function generateKeypair(): Keypair {
    const { privateKey } = generateKeyPairSync("x25519");
    const exported = privateKey.export({ format: "der", type: "pkcs8" });

    return keypairOf(Buffer.from(exported.subarray(PRIVATE_PREFIX.length)));
}

function dh(local: Keypair, remote: Buffer): Buffer {
    return diffieHellman({ privateKey: privateKeyObject(local.private), publicKey: publicKeyObject(remote) });
}

function hmac(key: Buffer, data: Buffer): Buffer {
    return createHmac("sha256", key).update(data).digest();
}

function hkdf(chainingKey: Buffer, material: Buffer): [Buffer, Buffer] {
    const temporary = hmac(chainingKey, material);
    const first = hmac(temporary, Buffer.from([1]));

    return [first, hmac(temporary, Buffer.concat([first, Buffer.from([2])]))];
}

/* One direction of the transport: ChaChaPoly with a 64-bit little-endian counter after four zero bytes. */
export class CipherState {
    private nonce = BigInt(0);

    constructor(private readonly key: Buffer) {}

    private iv(): Buffer {
        const iv = Buffer.alloc(12);
        iv.writeBigUInt64LE(this.nonce, 4);
        this.nonce += BigInt(1);

        return iv;
    }

    encrypt(plain: Buffer, associated: Buffer = EMPTY): Buffer {
        const cipher = createCipheriv("chacha20-poly1305", this.key, this.iv(), { authTagLength: TAG_LENGTH });
        cipher.setAAD(associated, { plaintextLength: plain.length });

        return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    }

    decrypt(sealed: Buffer, associated: Buffer = EMPTY): Buffer {
        if (sealed.length < TAG_LENGTH) {
            throw new Error("noise: message too short");
        }

        const body = sealed.subarray(0, sealed.length - TAG_LENGTH);
        const decipher = createDecipheriv("chacha20-poly1305", this.key, this.iv(), { authTagLength: TAG_LENGTH });
        decipher.setAAD(associated, { plaintextLength: body.length });
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));

        return Buffer.concat([decipher.update(body), decipher.final()]);
    }
}

class SymmetricState {
    private hash: Buffer = PROTOCOL;
    private chainingKey: Buffer = PROTOCOL;
    private cipher: CipherState | null = null;

    mixHash(data: Buffer) {
        this.hash = createHash("sha256").update(this.hash).update(data).digest();
    }

    mixKey(material: Buffer) {
        const [chainingKey, key] = hkdf(this.chainingKey, material);
        this.chainingKey = chainingKey;
        this.cipher = new CipherState(key);
    }

    encryptAndHash(plain: Buffer): Buffer {
        const sealed = this.cipher ? this.cipher.encrypt(plain, this.hash) : plain;
        this.mixHash(sealed);

        return sealed;
    }

    decryptAndHash(sealed: Buffer): Buffer {
        const plain = this.cipher ? this.cipher.decrypt(sealed, this.hash) : sealed;
        this.mixHash(sealed);

        return plain;
    }

    split(): [CipherState, CipherState] {
        const [first, second] = hkdf(this.chainingKey, EMPTY);

        return [new CipherState(first), new CipherState(second)];
    }
}

export interface Transport {
    sender: CipherState;
    receiver: CipherState;
    peer: Buffer;
}

function startState(prologue: string, responderStatic: Buffer): SymmetricState {
    const state = new SymmetricState();
    state.mixHash(Buffer.from(prologue, "ascii"));
    state.mixHash(responderStatic);

    return state;
}

/* The initiator's side of IK: it knows the responder's static key before it starts. */
export class Initiator {
    private readonly state: SymmetricState;
    private readonly ephemeral: Keypair;

    constructor(
        private readonly local: Keypair,
        private readonly remote: Buffer,
        prologue: string,
        ephemeral?: Keypair,
    ) {
        this.state = startState(prologue, remote);
        this.ephemeral = ephemeral ?? generateKeypair();
    }

    writeFirst(): Buffer {
        this.state.mixHash(this.ephemeral.public);
        this.state.mixKey(dh(this.ephemeral, this.remote));
        const sealedStatic = this.state.encryptAndHash(this.local.public);
        this.state.mixKey(dh(this.local, this.remote));

        return Buffer.concat([this.ephemeral.public, sealedStatic, this.state.encryptAndHash(EMPTY)]);
    }

    readSecond(message: Buffer): Transport {
        if (message.length < 32 + TAG_LENGTH) {
            throw new Error("noise: handshake reply too short");
        }

        const remoteEphemeral = message.subarray(0, 32);
        this.state.mixHash(remoteEphemeral);
        this.state.mixKey(dh(this.ephemeral, remoteEphemeral));
        this.state.mixKey(dh(this.local, remoteEphemeral));
        this.state.decryptAndHash(message.subarray(32));
        const [sender, receiver] = this.state.split();

        return { sender, receiver, peer: this.remote };
    }
}

/* The responder's side: it learns the initiator's static key from the first message. */
export class Responder {
    private readonly state: SymmetricState;
    private readonly ephemeral: Keypair;
    private remoteEphemeral: Buffer = EMPTY;
    private remoteStatic: Buffer = EMPTY;

    constructor(
        private readonly local: Keypair,
        prologue: string,
        ephemeral?: Keypair,
    ) {
        this.state = startState(prologue, local.public);
        this.ephemeral = ephemeral ?? generateKeypair();
    }

    readFirst(message: Buffer): Buffer {
        if (message.length < 32 + 32 + TAG_LENGTH * 2) {
            throw new Error("noise: handshake message too short");
        }

        this.remoteEphemeral = message.subarray(0, 32);
        this.state.mixHash(this.remoteEphemeral);
        this.state.mixKey(dh(this.local, this.remoteEphemeral));
        this.remoteStatic = this.state.decryptAndHash(message.subarray(32, 32 + 32 + TAG_LENGTH));
        this.state.mixKey(dh(this.local, this.remoteStatic));
        this.state.decryptAndHash(message.subarray(32 + 32 + TAG_LENGTH));

        return this.remoteStatic;
    }

    writeSecond(): [Buffer, Transport] {
        this.state.mixHash(this.ephemeral.public);
        this.state.mixKey(dh(this.ephemeral, this.remoteEphemeral));
        this.state.mixKey(dh(this.ephemeral, this.remoteStatic));
        const message = Buffer.concat([this.ephemeral.public, this.state.encryptAndHash(EMPTY)]);
        const [receiver, sender] = this.state.split();

        return [message, { sender, receiver, peer: this.remoteStatic }];
    }
}
