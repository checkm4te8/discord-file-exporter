const fs = require('fs').promises;
const path = require('path');
const inquirer = require('inquirer');
const ProgressBar = require('cli-progress');
const chalk = require('chalk');
const axios = require('axios');

async function countFiles(directoryPath) {
    try {
        const files = await fs.readdir(directoryPath);
        let totalFiles = 0;

        for (const file of files) {
            const filePath = path.join(directoryPath, file);
            const stats = await fs.stat(filePath);

            if (stats.isDirectory()) {
                totalFiles += await countFiles(filePath);
            } else {
                totalFiles++;
            }
        }

        return totalFiles;
    } catch (error) {
        return 0;
    }
}

function getSnowflakeTime(snowflake) {
    const timestamp = (BigInt(snowflake) >> 22n) + 1420070400000n;
    return new Date(Number(timestamp));
}

async function searchForURLs(filePath, urlList, progressBar) {
  try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      const regex = /https:\/\/cdn\.discordapp\.com\/(?:attachments|cdn)\/\d+\/(\d+)(?:\/\S*)?/gi;
      let match;

      while ((match = regex.exec(fileContent)) !== null) {
          let sanitizedURL = match[0].trim();
          if (sanitizedURL.endsWith(',"')) {
              sanitizedURL = sanitizedURL.slice(0, -2);
          }

          if (sanitizedURL.endsWith('",')) {
            sanitizedURL = sanitizedURL.slice(0, -2);
        }

        if (sanitizedURL.endsWith('"')) {
          sanitizedURL = sanitizedURL.slice(0, -1);
        }

        if (sanitizedURL.endsWith(',')) {
          sanitizedURL = sanitizedURL.slice(0, -1);
        }   

          const snowflake = BigInt(match[1]);
          const extension = sanitizeExtension(path.extname(sanitizedURL).toLowerCase());
          const url = sanitizedURL;

          // Check for duplicates before adding to the list
          if (!isDuplicate(urlList, url)) {
              urlList.add({ url, snowflake, extension });
          }
      }

      progressBar.increment();

      // Ensure the progress bar does not go beyond 100%
      if (progressBar.value > progressBar.total) {
          progressBar.stop();
      }
  } catch (error) {
      progressBar.increment();

      // Ensure the progress bar does not go beyond 100%
      if (progressBar.value > progressBar.total) {
          progressBar.stop();
      }
  }
}






function sanitizeExtension(extension) {
    // Remove non-alphanumeric characters from the extension
    return extension.replace(/[^a-zA-Z0-9]/g, '');
}

function isDuplicate(urlList, url) {
    // Check if the URL is already in the list
    for (const { url: existingURL } of urlList) {
        if (existingURL === url) {
            return true;
        }
    }
    return false;
}

function getFileExtensions(urlList) {
    const extensionCount = {};

    urlList.forEach(({ url, extension }) => {
        const ext = extension || 'unknown';

        if (extensionCount[ext]) {
            extensionCount[ext]++;
        } else {
            extensionCount[ext] = 1;
        }
    });

    return extensionCount;
}

function buildFolderStructure(urlList) {
    const folderStructure = {
        unknown: [],
    };

    urlList.forEach(({ url }) => {
        const snowflake = getSnowflake(url);
        if (snowflake) {
            const creationTime = getSnowflakeTime(snowflake);
            const year = creationTime.getFullYear();
            const month = creationTime.getMonth() + 1; // Month is 0-indexed
            const day = creationTime.getDate();

            folderStructure[year] = folderStructure[year] || {};
            folderStructure[year][month] = folderStructure[year][month] || {};
            folderStructure[year][month][day] = folderStructure[year][month][day] || [];
            folderStructure[year][month][day].push({ url });
        } else {
            folderStructure['unknown'].push({ url });
        }
    });

    return folderStructure;
}

function getSnowflake(url) {
    const snowflakeMatch = url.match(/\/attachments\/\d+\/(\d+)\//);
    return snowflakeMatch ? BigInt(snowflakeMatch[1]) : null;
}

async function createFolders(basePath, folderStructure) {
    try {
        // Create the ExportedFiles folder (delete if exists)
        const exportedFilesPath = path.join(basePath, 'ExportedFiles');
        await fs.rm(exportedFilesPath, { recursive: true, force: true });
        await fs.mkdir(exportedFilesPath);

        for (const [year, months] of Object.entries(folderStructure)) {
            const yearPath = path.join(exportedFilesPath, year.toString());
            await fs.mkdir(yearPath, { recursive: true });

            for (const [month, days] of Object.entries(months)) {
                const monthPath = path.join(yearPath, month.toString());
                await fs.mkdir(monthPath, { recursive: true });

                for (const [day, urls] of Object.entries(days)) {
                    const dayPath = path.join(monthPath, day.toString());
                    await fs.mkdir(dayPath, { recursive: true });
                }
            }
        }

        console.log('\n[ ' + chalk.bold.green("OK") + ' ] Folder structure successfully written to the drive.\n\n');
    } catch (error) {
        console.error('\n[ ' + chalk.bold.red('ERROR') + ' ] An error occurred during folder creation, exiting: ', error);
        process.exit(1);
    }
}

async function downloadFiles(urlList, downloadThreads, discordDataFolder) {
  const urls = Array.from(urlList);

  // Divide the array into chunks based on the number of download threads
  const chunks = [];
  for (let i = 0; i < urls.length; i += downloadThreads) {
      chunks.push(urls.slice(i, i + downloadThreads));
  }

  console.clear();

  const downloadProgressBar = new ProgressBar.SingleBar({
      format: `Downloading [{bar}] {percentage}% | ETA: {eta}s | {value}/${urls.length} Files`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      ...ProgressBar.Presets.shades_classic,
  });

  downloadProgressBar.start(urls.length, 0);

  let errorCount = 0;
  const errors = [];

  // Process each chunk concurrently
  await Promise.all(
      chunks.map(async (chunk) => {
          await Promise.all(
              chunk.map(async ({ url, snowflake, extension }) => {
                  const sanitizedExtension = sanitizeExtension(extension);

                  const snowflakeTime = getSnowflakeTime(snowflake);
                  const year = snowflakeTime.getFullYear();
                  const month = snowflakeTime.getMonth() + 1; // Month is 0-indexed
                  const day = snowflakeTime.getDate();

                  const originalFileName = path.basename(url);

                  const filePath = path.join(
                      discordDataFolder,
                      'ExportedFiles',
                      year.toString(),
                      month.toString(),
                      day.toString(),
                      originalFileName
                  );

                  let success = false;

                  while (!success) {
                      try {
                          const response = await axios.get(url, { responseType: 'arraybuffer' });
                          await fs.writeFile(filePath, Buffer.from(response.data));
                          await fs.utimes(filePath, snowflakeTime, snowflakeTime);
                          success = true; // File downloaded successfully
                      } catch (error) {
                          if (axios.isAxiosError(error)) {
                              if (error.response) {
                                  if (error.response.status === 404) {
                                      // 404 error, skip the file
                                      success = true;
                                      errorCount++;
                                      errors.push({ url, snowflake, error: '404 - Not Found' });
                                  } else {
                                      // Other known errors, retry the request
                                      await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
                                  }
                              } else {
                                  // No response from Discord, retry the request
                                  await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
                              }
                          } else {
                              // Other errors, retry the request
                              await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
                          }
                      }
                  }

                  downloadProgressBar.increment();
              })
          );
      })
  );

  downloadProgressBar.stop();

  if (errorCount > 0) {
      console.log(`\n[ ${chalk.bold.red('ERROR')} ] Download completed with ${errorCount} error(s):`);
      errors.forEach(({ url, error }) => {
          console.log(`  - ${chalk.bold.yellow(url)}: ${chalk.red(error)}`);
      });
  } else {
      console.log('\n[ ' + chalk.bold.green('OK') + ' ] Download completed successfully.\n');
  }
}



async function processFiles(directoryPath, urlList, progressBar) {
    try {
        const files = await fs.readdir(directoryPath);

        for (const file of files) {
            const filePath = path.join(directoryPath, file);

            const stats = await fs.stat(filePath);

            if (stats.isDirectory()) {
                await processFiles(filePath, urlList, progressBar);
            } else {
                await searchForURLs(filePath, urlList, progressBar);
            }
        }
    } catch (error) {
        console.error('Error processing files:', error);
    }
}

async function main() {
    console.clear();

    const discordDataFolder = 'E:\\Dokumenty\\Discord'; // Replace with your actual path
    const totalFiles = await countFiles(discordDataFolder);

    console.clear();

    const { downloadThreads } = await inquirer.prompt([
        {
            type: 'number',
            name: 'downloadThreads',
            prefix: '',
            message: '[ ' + chalk.bold.cyan("INPUT") + ' ] Please enter the maximum amount of workers to use during the download process: ',
            default: 5,
        },
    ]);

    console.clear();

    console.log('[ ' + chalk.bold.blue("WAIT") + ' ] Please wait, tallying files and preparing to build the folder structure... \n\n');

    const progressBar = new ProgressBar.SingleBar({
        format: `Progress [{bar}] {percentage}% | ETA: {eta}s | {value}/${totalFiles} Files`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        ...ProgressBar.Presets.shades_classic,
    });

    const urlList = new Set();

    try {
        progressBar.start(totalFiles, 0);

        await processFiles(discordDataFolder, urlList, progressBar);

        progressBar.stop();

        console.clear();
        console.log('\n[ ' + chalk.bold.green("OK") + ' ] Files tallied successfully, found ' + chalk.bold.yellow(urlList.size) + ' URLS in ' + chalk.bold.yellow(totalFiles) + ' files.\n\n');

        const extensionCount = getFileExtensions(urlList);

        // Display file extension breakdown
        console.log(chalk.bold.green('Search breakdown:'));
        Object.entries(extensionCount)
            .sort((a, b) => b[1] - a[1])
            .forEach(([extension, count]) => {
                const coloredExtension = extension === 'unknown' ? chalk.gray(extension) : chalk.cyan(extension);
                console.log(`${coloredExtension} files - ${count}`);
            });

        // Ask the user if they want to proceed with the download process
        const { proceed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                prefix: '',
                message: '[ ' + chalk.bold.cyan("INPUT") + ' ] Do you want to proceed with the download process? (Y/N):',
                default: false,
            },
        ]);

        if (proceed) {
          // Build folder structure
          console.log('\n[ ' + chalk.bold.blue("WAIT") + ' ] Building folder structure...\n\n');
      
          const folderStructure = buildFolderStructure(urlList);
      
          // Create folders
          await createFolders(discordDataFolder, folderStructure);
      
          // Download files
          console.log('\n[ ' + chalk.bold.blue("WAIT") + ' ] Downloading files, please wait, this may take a while, do not panic if it looks stuck...\n\n');
          await downloadFiles(urlList, downloadThreads, discordDataFolder);
      } else {
          console.log('\n[ ' + chalk.bold.yellow("INFO") + ' ] Download process aborted.');
      }
    } catch (error) {
        console.error('\n[ ' + chalk.bold.red('ERROR') + ' ] An error occurred during processing: ', error);
        process.exit(1);
    }
}

main();