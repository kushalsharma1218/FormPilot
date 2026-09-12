/* eslint-disable no-var */
/**
 * lib/crypto-utils.js — End-to-End Encryption (E2EE) utilities for FormPilot AI.
 * Uses Web Crypto API (SubtleCrypto) for AES-256-GCM.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.JobAutofill = root.JobAutofill || {};
        root.JobAutofill.CryptoUtils = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var ALGO = 'AES-GCM';
    var KEY_LEN = 256;
    var PBKDF2_ITERATIONS = 100000;
    var SALT_LEN = 16;
    var IV_LEN = 12;

    /**
     * Derives a CryptoKey from a passphrase using PBKDF2.
     * @param {string} passphrase 
     * @param {Uint8Array} salt 
     * @returns {Promise<CryptoKey>}
     */
    async function deriveKey(passphrase, salt) {
        var enc = new TextEncoder();
        var keyMaterial = await crypto.subtle.importKey(
            'raw',
            enc.encode(passphrase),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: PBKDF2_ITERATIONS,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: ALGO, length: KEY_LEN },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Encrypts an object or string.
     * @param {any} data 
     * @param {CryptoKey} key 
     * @returns {Promise<{iv: string, ciphertext: string}>}
     */
    async function encrypt(data, key) {
        var enc = new TextEncoder();
        var iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
        var plainText = typeof data === 'string' ? data : JSON.stringify(data);

        var ciphertext = await crypto.subtle.encrypt(
            {
                name: ALGO,
                iv: iv
            },
            key,
            enc.encode(plainText)
        );

        return {
            iv: b64Encode(iv),
            ciphertext: b64Encode(new Uint8Array(ciphertext))
        };
    }

    /**
     * Decrypts a ciphertext.
     * @param {string} ciphertextBase64 
     * @param {string} ivBase64 
     * @param {CryptoKey} key 
     * @returns {Promise<any>}
     */
    async function decrypt(ciphertextBase64, ivBase64, key) {
        var dec = new TextDecoder();
        var iv = b64Decode(ivBase64);
        var ciphertext = b64Decode(ciphertextBase64);

        try {
            var decrypted = await crypto.subtle.decrypt(
                {
                    name: ALGO,
                    iv: iv
                },
                key,
                ciphertext
            );

            var plainText = dec.decode(decrypted);
            try {
                return JSON.parse(plainText);
            } catch (e) {
                return plainText;
            }
        } catch (err) {
            console.error('[Crypto] Decryption failed:', err);
            throw new Error('Encryption key incorrect or data corrupted');
        }
    }

    /**
     * Generates a random salt.
     */
    function generateSalt() {
        return crypto.getRandomValues(new Uint8Array(SALT_LEN));
    }

    // ── Helpers ──────────────────────────────────────────────────

    function b64Encode(bytes) {
        var binString = '';
        for (var i = 0; i < bytes.length; i++) {
            binString += String.fromCharCode(bytes[i]);
        }
        return btoa(binString);
    }

    function b64Decode(str) {
        var binString = atob(str);
        var bytes = new Uint8Array(binString.length);
        for (var i = 0; i < binString.length; i++) {
            bytes[i] = binString.charCodeAt(i);
        }
        return bytes;
    }

    return {
        deriveKey: deriveKey,
        encrypt: encrypt,
        decrypt: decrypt,
        generateSalt: generateSalt,
        b64Encode: b64Encode,
        b64Decode: b64Decode
    };
});
