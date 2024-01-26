# Discord file exporter

This simple to use tool exports all the media in your Discord data package.

## How does it work?
The tool enumerates all the attachment files in your Discord data package, finds links, sanitates them (ensures they are in a valid format) and gets their snowflake, from which it derives the exact time the media was created. 
After enumeration, it creates a chronologic folder structure (files are sorted based on year, month and day) and downloads and writes the data to it, ensuring all data is actually downloaded. 

## How to use?
Simply place it in the root folder of your DIscord data package, download the dependencies using `npm install` and run it with `node FileExporter.js`, then follow the instructions. Default settings are ok in most cases.
