/* Example local configuration.
   To ship your own subscription inside the build, copy this file to
   js/local-config.js and put your URL in it. That file is listed in .gitignore,
   so it never reaches the repository.

   You do not need it: on first launch the app asks for the M3U URL on the setup
   screen and stores it on the device. */
var LOCAL_CONFIG = {
  source: 'http://example-server:8080/get.php?username=USER&password=PASS&type=m3u_plus&output=mpegts'
};
