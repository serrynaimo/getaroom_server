/*  Instructions for using the config-example.js file.
  To use your own API key or any other private settings for this app:
  MAKE A COPY of config_example.js (do NOT edit config-example.js for app usage)
    in this directory (config/) and name it "config.js".
  Replace the values below as appropriate.
*/

/*
API keys and secrets can be kept in this file as
  config/config.js is ignored by git and will not be committed
*/

module.exports = {
  googleSettings: {
    /*
    Google API project can be created at:
      https://cloud.google.com/console
    Reference values can be found at:
    https://temasys.atlassian.net/wiki/x/MAD8
    */
    apiKey: 'Enter your Google API project api key here.',
    projectId: 'Enter your Google API project Project ID here.',
    projectNo: 'Enter your Google API project Project Number here.',
  },
}
