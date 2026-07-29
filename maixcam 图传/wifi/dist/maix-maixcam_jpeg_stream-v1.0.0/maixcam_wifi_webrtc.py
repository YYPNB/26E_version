from maix import network, err, camera, http, time, app

WIFI_SSID = "Zz"
WIFI_PASSWORD = "zzzjw666"

wifi = network.wifi.Wifi()
print("Connecting WiFi:", WIFI_SSID)

ret = wifi.connect(WIFI_SSID, WIFI_PASSWORD, wait=True, timeout=60)
err.check_raise(ret, "WiFi connect failed")

ip = wifi.get_ip()
print("WiFi connected, IP:", ip)

html = """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>MaixCAM JPG Stream</title>
    <style>
        body { margin: 0; background: #111; color: white; font-family: sans-serif; }
        img { width: 100vw; height: auto; display: block; }
    </style>
</head>
<body>
    <img src="/stream" alt="MaixCAM Stream">
</body>
</html>
"""

cam = camera.Camera(320, 240)
stream = http.JpegStreamer()
stream.set_html(html)
stream.start()

print("Open in browser:")
print("http://{}:{}".format(ip, stream.port()))

while not app.need_exit():
    img = cam.read()
    jpg = img.to_jpeg()
    stream.write(jpg)