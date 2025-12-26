const readline = require('readline');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');
const MsrDevice = require('./lib/MsrDevice');
const { track1ISOAlphabetInverted } = require('./lib/constants');

const device = new MsrDevice();

const runWithCancellation = async (fn) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const handleKeypress = (str, key) => {
        if (key.ctrl && key.name === 'c') {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.exit(0);
        }
        if (key.name === 'escape') {
            device.cancel();
        }
    };

    process.stdin.on('keypress', handleKeypress);

    try {
        return await fn();
    } finally {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
    }
};

const displayBanner = () => {
    console.clear();
    const logo = `
.___  ___.      _______..______         .___________.  ______     ______    __      
|   \\/   |     /       ||   _  \\        |           | /  __  \\   /  __  \\  |  |     
|  \\  /  |    |   (----\`|  |_)  |       \`---|  |----\`|  |  |  | |  |  |  | |  |     
|  |\\/|  |     \\   \\    |      /            |  |     |  |  |  | |  |  |  | |  |     
|  |  |  | .----)   |   |  |\\  \\----.       |  |     |  \`--'  | |  \`--'  | |  \`----.
|__|  |__| |_______/    | _| \`._____|       |__|      \\______/   \\______/  |_______|
`;
    console.log(
        boxen(
            chalk.cyan(logo),
            { padding: 1, margin: 1, borderStyle: 'round', borderColor: 'cyan' }
        )
    );
    console.log(chalk.dim('  Magnetic Stripe Reader/Writer CLI Tool\n'));
};

const formatTrackData = (data, trackNum) => {
    if (!data) return chalk.gray('Empty');
    if (data === 'Corrupt Data') return chalk.red('Corrupt Data');
    if (data === 'No Data') return chalk.gray('No Data');
    return chalk.green(data);
};

const handleRead = async () => {
    const spinner = ora('Waiting for card swipe...').start();
    try {
        await runWithCancellation(async () => {
            await device.sendControl(device.assemblePacket('enableRead'));
            const { isoTracks, trackData } = await device.readData();
            spinner.succeed('Card read successfully!');

            console.log('\n' + boxen(
                `Track 1: ${formatTrackData(isoTracks[0], 1)}\n` +
                `Track 2: ${formatTrackData(isoTracks[1], 2)}\n` +
                `Track 3: ${formatTrackData(isoTracks[2], 3)}`,
                { title: 'Card Data (ISO)', borderStyle: 'round', padding: 1 }
            ));
        });

        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
    } catch (error) {
        if (error.message === 'Operation aborted by user') {
            spinner.stop();
            return;
        }
        spinner.fail(`Read failed: ${error.message}`);
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
    } finally {
        try { await device.reset(); } catch (e) {}
    }
};

const handleWrite = async () => {
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'track1',
            message: 'Enter Track 1 Data (or leave empty):',
        },
        {
            type: 'input',
            name: 'track2',
            message: 'Enter Track 2 Data (or leave empty):',
        },
        {
            type: 'input',
            name: 'track3',
            message: 'Enter Track 3 Data (or leave empty):',
        }
    ]);

    const data = [
        answers.track1 || '',
        answers.track2 || '',
        answers.track3 || ''
    ];

    const spinner = ora('Preparing to write...').start();

    try {
        // Encode data
        const isoEncoded = [
            data[0] ? await device.encodeISO(require('./lib/constants').track0ISOAlphabetInverted, 7, data[0]) : [0],
            data[1] ? await device.encodeISO(track1ISOAlphabetInverted, 5, data[1]) : [0],
            data[2] ? await device.encodeISO(track1ISOAlphabetInverted, 5, data[2]) : [0],
        ];

        await runWithCancellation(async () => {
            spinner.text = 'Please swipe card to WRITE...';
            
            let success = false;
            for (let i = 0; i < 3; i++) {
                if (await device.writeRawData(isoEncoded)) {
                    success = true;
                    break;
                }
                spinner.text = `Write failed, retrying (${i + 1}/3)... Swipe again.`;
            }

            if (success) {
                spinner.succeed('Card written successfully!');
            } else {
                spinner.fail('Failed to write after multiple attempts.');
            }
        });
    } catch (error) {
        if (error.message === 'Operation aborted by user') {
            spinner.stop();
            return;
        }
        spinner.fail(`Write Error: ${error.message}`);
    } finally {
        await device.reset();
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
    }
};

const handleClone = async () => {
    const readSpinner = ora('Waiting for source card swipe...').start();
    let sourceData = null;

    try {
        await runWithCancellation(async () => {
            await device.sendControl(device.assemblePacket('enableRead'));
            const result = await device.readData();
            sourceData = result.trackData; // Use raw track data for exact clone
            readSpinner.succeed('Source card read!');
        });
    } catch (error) {
        if (error.message === 'Operation aborted by user') {
            readSpinner.stop();
            return;
        }
        readSpinner.fail(`Read failed: ${error.message}`);
        await device.reset();
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
        return;
    }

    console.log(chalk.yellow('\nRemove source card and prepare target card.\n'));
    await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter when ready to WRITE...' }]);

    const writeSpinner = ora('Please swipe target card to WRITE...').start();
    try {
        await runWithCancellation(async () => {
            let success = false;
            for (let i = 0; i < 3; i++) {
                if (await device.writeRawData(sourceData)) {
                    success = true;
                    break;
                }
                writeSpinner.text = `Write failed, retrying (${i + 1}/3)... Swipe again.`;
            }

            if (success) {
                writeSpinner.succeed('Card cloned successfully!');
            } else {
                writeSpinner.fail('Failed to write clone after multiple attempts.');
            }
        });
    } catch (error) {
        if (error.message === 'Operation aborted by user') {
            writeSpinner.stop();
            return;
        }
        writeSpinner.fail(`Write Error: ${error.message}`);
    } finally {
        await device.reset();
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
    }
};

const handleValidate = async () => {
    const masterSpinner = ora('Waiting for MASTER card swipe...').start();
    let masterTracks = null;

    try {
        await runWithCancellation(async () => {
            await device.sendControl(device.assemblePacket('enableRead'));
            const { isoTracks } = await device.readData();
            masterTracks = isoTracks;
            masterSpinner.succeed('Master card captured!');
            
            console.log(boxen(
                `Track 1: ${formatTrackData(masterTracks[0], 1)}\n` +
                `Track 2: ${formatTrackData(masterTracks[1], 2)}\n` +
                `Track 3: ${formatTrackData(masterTracks[2], 3)}`,
                { title: 'Master Data', borderStyle: 'round', padding: 1, borderColor: 'yellow' }
            ));
        });

    } catch (error) {
        if (error.message === 'Operation aborted by user') {
            masterSpinner.stop();
            return;
        }
        masterSpinner.fail(`Read failed: ${error.message}`);
        await device.reset();
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
        return;
    }

    console.log(chalk.cyan('\nNow swipe cards to validate against the Master. Press ESC to stop.\n'));

    const spinner = ora('Waiting for card swipe...').start();

    await runWithCancellation(async () => {
        while (true) {
            try {
                await device.sendControl(device.assemblePacket('enableRead'));
                
                // Wait for data
                const { isoTracks } = await device.readData();

                // Clear the "Waiting..." spinner so we can print the result cleanly
                spinner.stop();

                const isMatch = 
                    isoTracks[0] === masterTracks[0] &&
                    isoTracks[1] === masterTracks[1] &&
                    isoTracks[2] === masterTracks[2];

                if (isMatch) {
                    spinner.succeed(chalk.green.bold('MATCH VALIDATED ✅'));
                } else {
                    spinner.fail(chalk.red.bold('MISMATCH DETECTED ❌'));
                    console.log(boxen(
                        `Track 1: ${isoTracks[0] === masterTracks[0] ? chalk.green('MATCH') : chalk.red('MISMATCH')}\n` +
                        `Track 2: ${isoTracks[1] === masterTracks[1] ? chalk.green('MATCH') : chalk.red('MISMATCH')}\n` +
                        `Track 3: ${isoTracks[2] === masterTracks[2] ? chalk.green('MATCH') : chalk.red('MISMATCH')}`,
                        { title: 'Validation Details', borderStyle: 'round', padding: 1, borderColor: 'red' }
                    ));
                }
                
                // Short delay to let the user see the result before "Waiting..." appears again
                await new Promise(r => setTimeout(r, 1500));
                // check running again after sleep in case ESC was pressed
                spinner.start('Waiting for card swipe...');

            } catch (error) {
                if (error.message === 'Operation aborted by user') {
                    break;
                }
                
                // If we are still running, show error and restart spinner
                spinner.fail(`Read error: ${error.message}`);
                if (error.message.includes('disconnected')) {
                    break;
                }
                await new Promise(r => setTimeout(r, 1000));
                spinner.start('Waiting for card swipe...');
            }
        }
    });
    
    // Cleanup
    if (spinner.isSpinning) spinner.stop();
    try { await device.reset(); } catch (e) {}
};

const handleClear = async () => {
    const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'sure',
        message: 'Are you sure you want to ERASE all data on the card?',
        default: false
    }]);

    if (!confirm.sure) return;

    const spinner = ora('Preparing to erase...').start();
    try {
        // Empty raw packets usually imply erasure or writing nulls depending on how writeRawData handles it
        // The original code handled 'erase' by sending null bytes or specific erase patterns.
        // Let's assume sending valid but empty ISO structures effectively clears it or we can try writing 0s.
        // The original code: data[0] == '\0' ? [0] : ...
        // So we send [0] for each track.
        const emptyEncoded = [[0], [0], [0]];

        await runWithCancellation(async () => {
            spinner.text = 'Swipe card to ERASE...';
            
            let success = false;
            for (let i = 0; i < 3; i++) {
                if (await device.writeRawData(emptyEncoded)) {
                    success = true;
                    break;
                }
                spinner.text = `Erase failed, retrying (${i + 1}/3)... Swipe again.`;
            }

            if (success) {
                spinner.succeed('Card erased successfully!');
            } else {
                spinner.fail('Failed to erase after multiple attempts.');
            }
        });
    } catch (error) {
        if (error.message === 'Operation aborted by user') {
            spinner.stop();
            return;
        }
        spinner.fail(`Erase Error: ${error.message}`);
    } finally {
        await device.reset();
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to continue...' }]);
    }
};

const mainMenu = async () => {
    while (true) {
        displayBanner();
        
        if (!device.connected) {
            console.log(chalk.yellow('Connecting to device...'));
            try {
                await device.connect();
                console.log(chalk.green('Device Connected!'));
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                if (e.message === 'ACCESS_DENIED') {
                    console.log(chalk.red('\nERROR: Could not access device.'));
                    console.log(chalk.yellow('This typically means Windows has locked the device driver.'));
                    console.log(boxen(
                        'SOLUTION: You must install the WinUSB driver using Zadig.\n' +
                        '1. Download Zadig from https://zadig.akeo.ie/\n' +
                        '2. Open Zadig, select "Options" -> "List All Devices"\n' +
                        '3. Select "MSR605X" (or USB Input Device 0801:0003)\n' +
                        '4. Ensure target driver is "WinUSB" and click "Replace Driver"\n' +
                        '5. Unplug and replug the device.',
                        { padding: 1, borderStyle: 'double', borderColor: 'yellow' }
                    ));
                    // Wait longer before retrying to let user read
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    console.log(chalk.red(`Failed to connect: ${e.message}`));
                    console.log(chalk.dim('Retrying in 2 seconds...'));
                    await new Promise(r => setTimeout(r, 2000));
                }
                continue;
            }
        }

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: '📖  Read Card', value: 'read' },
                    { name: '✍️   Write Card', value: 'write' },
                    { name: '👯  Clone Card', value: 'clone' },
                    { name: '✅  Validate Cards', value: 'validate' },
                    { name: '🧹  Clear Card', value: 'clear' },
                    new inquirer.Separator(),
                    { name: '❌  Exit', value: 'exit' }
                ]
            }
        ]);

        if (action === 'exit') {
            console.log(chalk.blue('Goodbye!'));
            process.exit(0);
        }

        switch (action) {
            case 'read':
                await handleRead();
                break;
            case 'write':
                await handleWrite();
                break;
            case 'clone':
                await handleClone();
                break;
            case 'validate':
                await handleValidate();
                break;
            case 'clear':
                await handleClear();
                break;
        }
    }
};

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
    if (device) {
        device.cancel();
        try { await device.reset(); } catch (e) {}
    }
    console.log('\n' + chalk.blue('Goodbye!'));
    process.exit(0);
});

// Start the application
(async () => {
    try {
        await mainMenu();
    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
})();
