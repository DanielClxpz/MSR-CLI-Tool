
const usb = require('usb');
const os = require('os');
const { 
    commands, 
    deviceConfig, 
    track0ISOAlphabet, 
    track1ISOAlphabet, 
    track0ISOAlphabetInverted, 
    track1ISOAlphabetInverted 
} = require('./constants');
const { 
    lrc, 
    parsePacket, 
    toHexString, 
    bitStream, 
    sleep 
} = require('./utils');

class MsrDevice {
    constructor() {
        this.device = null;
        this.interface = null;
        this.reader = null;
        this.controlChain = Promise.resolve();
        this.connected = false;
        this.isCancelling = false;
    }

    async connect() {
        const device = usb.findByIds(0x0801, 0x0003);

        if (!device) {
            throw new Error('Device not found. Is the MSR605X connected?');
        }

        try {
            device.open();
        } catch (e) {
            if (e.message.includes('LIBUSB_ERROR_ACCESS')) {
                // Return a specific error object or throw with a clear message that the UI can handle
                throw new Error('ACCESS_DENIED');
            }
            throw e;
        }

        const [iface] = device.interfaces;

        if (os.platform() !== 'win32') {
            try {
                if (iface.isKernelDriverActive()) {
                    iface.detachKernelDriver();
                }
            } catch (e) {
                // Ignore
            }
        }

        iface.claim();
        this.device = device;
        this.interface = iface;
        this.connected = true;

        const inEndpoint = iface.endpoints.find(ep => ep.direction === 'in');
        if (!inEndpoint) {
            throw new Error('No IN endpoint found on device');
        }

        this.reader = this.createPacketReader(inEndpoint);
        await sleep(100);

        try {
            await this.sendControl(this.assemblePacket('reset'));
        } catch (e) {
            // Ignore reset failure on init
        }
        
        await this.initializeDevice();
    }

    async initializeDevice() {
        // Skip firmware check to save time or handle it silently
        await this.sendControl(this.assemblePacket('getFirmwareVersion'));
        await this.readReturn(); // Consume response
        
        await this.sendControl(this.assemblePacket('disableRead'));
        await this.readSuccess();

        let bpc = deviceConfig.tracks.map(track => track.bpc);
        await this.sendControl(this.assemblePacket('setBPC', bpc));
        await this.readSuccess();
        await this.reader.drain();

        await this.sendControl(this.assemblePacket(deviceConfig.isHiCo ? 'setHiCo' : 'setLoCo'));
        await this.readSuccess();
        await this.reader.drain();

        await this.sendControl(this.assemblePacket('setBPI', [deviceConfig.tracks[0].bpi == 210 ? 0xa1 : 0xa0]));
        await this.readSuccess();
        await this.reader.drain();

        await this.sendControl(this.assemblePacket('setBPI', [deviceConfig.tracks[1].bpi == 210 ? 0xc1 : 0xc0]));
        await this.readSuccess();
        await this.reader.drain();

        await this.sendControl(this.assemblePacket('setBPI', [deviceConfig.tracks[2].bpi == 210 ? 0xd2 : 0x4b]));
        await this.readSuccess();
        await this.reader.drain();

        await this.sendControl(this.assemblePacket('setLeadingZeros', [deviceConfig.leadingZero210, deviceConfig.leadingZero75]));
        await this.readSuccess();
        await this.reader.drain();
    }

    createPacketReader(endpoint) {
        const packetSize = endpoint.descriptor.wMaxPacketSize || 64;
        endpoint.startPoll(1, packetSize);
        
        let currentWaiters = [];
        let incoming = [];
        let currentData = [];
        let errorState = null;

        endpoint.on('data', (data) => {
            let head = data[0];
            if ((head & 0x80) != 0x80 && currentData.length == 0) {
                const err = new Error('invalid header byte received');
                if (currentWaiters.length > 0) {
                    currentWaiters.shift().reject(err);
                }
                return;
            }
            let length = head & 0x3F;
            currentData.push(...(data.slice(1, length + 1)));
            if ((head & 0x40) != 0x40) { // continuation
                return;
            }

            if (currentWaiters.length > 0) {
                currentWaiters.shift().resolve(currentData);
            } else {
                incoming.push(currentData);
            }
            currentData = [];
        });

        endpoint.on('error', (error) => {
            errorState = error;
            currentWaiters.forEach(w => w.reject(error));
            currentWaiters = [];
        });

        endpoint.on('end', () => {
            this.connected = false;
            errorState = new Error('Device disconnected');
            currentWaiters.forEach(w => w.reject(errorState));
            currentWaiters = [];
        });

        return {
            next: (timeout = 0) => {
                return {
                    value: new Promise((resolve, reject) => {
                        if (errorState) return reject(errorState);
                        if (incoming.length > 0) {
                            return resolve(incoming.shift());
                        }
                        if (!this.connected) return reject(new Error('Device disconnected'));
                        
                        let timer = null;
                        const wrappedResolve = (data) => {
                            if (timer) clearTimeout(timer);
                            resolve(data);
                        };
                        const wrappedReject = (err) => {
                            if (timer) clearTimeout(timer);
                            reject(err);
                        };
                        
                        const waiter = { resolve: wrappedResolve, reject: wrappedReject };
                        currentWaiters.push(waiter);

                        if (timeout > 0) {
                            timer = setTimeout(() => {
                                const idx = currentWaiters.indexOf(waiter);
                                if (idx !== -1) {
                                    currentWaiters.splice(idx, 1);
                                    wrappedReject(new Error('Timeout waiting for packet'));
                                }
                            }, timeout);
                        }
                    })
                };
            },
            flush: () => {
                incoming = [];
                currentData = [];
            },
            drain: async () => {
                incoming = [];
                currentData = [];
                while (true) {
                    const result = await Promise.race([
                        new Promise(resolve => {
                            if (incoming.length > 0) resolve(incoming.shift());
                            else {
                                const waiter = { resolve: (data) => resolve(data), reject: () => {} };
                                currentWaiters.push(waiter);
                                setTimeout(() => {
                                    const idx = currentWaiters.indexOf(waiter);
                                    if (idx !== -1) {
                                        currentWaiters.splice(idx, 1);
                                        resolve(null);
                                    }
                                }, 50);
                            }
                        })
                    ]);
                    if (!result) break;
                }
            },
            cancel: (reason) => {
                if (currentWaiters.length > 0) {
                    currentWaiters.forEach(w => w.reject(reason));
                    currentWaiters = [];
                }
            }
        };
    }

    sendControlChunk(packet) {
        return new Promise((resolve, reject) => {
            let buffer = packet;
            if (packet.length < 64) {
                buffer = Buffer.alloc(64);
                packet.copy(buffer);
            }

            this.device.controlTransfer(0x21, 9, 0x0300, 0, buffer, (error, data) => {
                if (error != null) {
                    reject(error);
                }
                resolve(data);
            });
        });
    }

    async _sendControl(packet) {
        let written = 0;
        while (written < packet.length) {
            let header = 0x80;
            let len = 0x3F;
            if (packet.length - written < 0x3F) {
                header |= 0x40;
                len = packet.length - written;
            }
            header |= len;
            let chunk = [header, ...packet.slice(written, written + len)];
            written += len;
            await this.sendControlChunk(Buffer.from(chunk));
        }
    }

    sendControl(packet) {
        const promise = this.controlChain.then(() => this._sendControl(packet));
        this.controlChain = promise.catch(() => {});
        return promise;
    }

    assemblePacket(opcode, data = []) {
        const opcodeEncoded = parsePacket(commands[opcode] || opcode);
        return [...opcodeEncoded, ...data];
    }

    async readSuccess() {
        if (this.isCancelling) throw new Error('Operation aborted by user');
        const startTime = Date.now();
        while (Date.now() - startTime < 3000) {
            try {
                const received = await this.reader.next(500).value;
                if (!received) continue;
                if (received.length >= 2 && received[0] == 0x1B && received[1] == 0x30) {
                    return true;
                }
            } catch (e) {
                if (e.message === 'Operation aborted by user') throw e;
            }
        }
        try { await this.sendControl(this.assemblePacket('disableRead')); } catch (err) {}
        return false;
    }

    async readReturn() {
        if (this.isCancelling) throw new Error('Operation aborted by user');
        const startTime = Date.now();
        while (Date.now() - startTime < 3000) {
            try {
                const received = await this.reader.next(500).value;
                if (!received) continue;
                if (received.length == 2 && received[0] == 0x1B) continue;
                if (received.length >= 2 && received[0] == 0x1B && received[1] != 0x30) {
                    return received.slice(1);
                }
            } catch (e) {
                if (e.message === 'Operation aborted by user') throw e;
            }
        }
        try { await this.sendControl(this.assemblePacket('disableRead')); } catch (err) {}
        return null;
    }

    async readData() {
        if (this.isCancelling) throw new Error('Operation aborted by user');
        const received = await this.reader.next().value;
        if (received == null || received[0] != 0x1B || received[1] != 0x73) {
            throw new Error('malformed response from device');
        }
        let trackData = [];
        let rIndex = 2;
        for (let i = 1; i <= 3; ++i) {
            if (received[rIndex] != 0x1B || received[rIndex + 1] != i) {
                throw new Error('malformed response from device');
            }
            rIndex += 2;
            const trackLength = received[rIndex];
            ++rIndex;
            trackData.push(received.slice(rIndex, rIndex + trackLength));
            rIndex += trackLength;
        }

        const isoDecoded = [[], [], []];
        let track0Stream = bitStream(trackData[0]);
        let temp = null;
        while ((temp = track0Stream.read(7)) != null) {
            isoDecoded[0].push(track0ISOAlphabet[temp.toString()] || '~');
        }
        let track1Stream = bitStream(trackData[1]);
        while ((temp = track1Stream.read(5)) != null) {
            isoDecoded[1].push(track1ISOAlphabet[temp.toString()] || '~');
        }
        let track2Stream = bitStream(trackData[2]);
        while ((temp = track2Stream.read(5)) != null) {
            isoDecoded[2].push(track1ISOAlphabet[temp.toString()] || '~');
        }
        let isoTracks = isoDecoded.map(track => track.join(''));

        for (let i = 0; i < isoTracks.length; ++i) {
            let endIndex = isoTracks[i].indexOf('?');
            let startIndex = isoTracks[i].indexOf(';');
            if (startIndex < 0 || endIndex < 0) {
                isoTracks[i] = isoTracks[i].length > 0 ? 'Corrupt Data' : 'No Data';
            } else {
                isoTracks[i] = isoTracks[i].slice(startIndex, endIndex + 1);
                if (isoTracks[i].includes('~')) {
                    isoTracks[i] = 'Corrupt Data';
                }
            }
        }
        return { isoTracks, trackData };
    }

    async writeRawData(data) {
        if (this.isCancelling) throw new Error('Operation aborted by user');
        const tracks = data.map(track => track.map(octet => {
            let bits = [octet & 0x80, octet & 0x40, octet & 0x20, octet & 0x10, octet & 0x08, octet & 0x04, octet & 0x02, octet & 0x01].map(bit => bit != 0);
            let value = 0;
            let currentBit = 0x80;
            for(let i = bits.length - 1; i >= 0; --i) {
                if (bits[i]) {
                    value |= currentBit;
                }
                currentBit /= 2;
            }
            return value;
        }));
        const outData = [0x1b, 0x01, tracks[0].length, ...tracks[0], 0x1b, 0x02, tracks[1].length, ...tracks[1], 0x1b, 0x03, tracks[2].length, ...tracks[2], 0x3F, 0x1C];
        
        await this.sendControl(this.assemblePacket('enableWrite', outData));
        const success = await this.readSuccess();
        return success;
    }

    async encodeISO(map, length, track) {
        const output = [];
        const outStream = bitStream(output);
        track.split('').map(c => map[c] || c).forEach(c => {
            if (typeof c == 'string') {
                throw new Error('invalid character in track: ' + c);
            }
            outStream.write(length, c);
        });
        if (track.length > 0) {
            outStream.write(length, lrc(length, map, track.split('')));
        }
        return output;
    }

    cancel() {
        this.isCancelling = true;
        if (this.reader) {
            this.reader.cancel(new Error('Operation aborted by user'));
        }
    }

    async reset() {
        this.isCancelling = false;
        try {
            await this.sendControl(this.assemblePacket('disableRead'));
        } catch (e) {
            // ignore
        }
    }
}

module.exports = MsrDevice;
