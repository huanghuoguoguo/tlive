package web

import "embed"

//go:embed *.html css/*.css js/*.js js/vendor/*.js
var Assets embed.FS
