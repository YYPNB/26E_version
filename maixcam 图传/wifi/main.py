from maix import network, err, camera, http, time, app


WIFI_SSID = "Zz"
WIFI_PASSWORD = "zzzjw666"
WIFI_TIMEOUT_S = 20
CAMERA_WIDTH = 320
CAMERA_HEIGHT = 240


HTML = """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MaixCAM JPG Stream</title>
    <style>
        body { margin: 0; background: #111; color: white; font-family: sans-serif; }
        main { min-height: 100vh; display: grid; place-items: center; }
        img { width: 100vw; max-height: 100vh; object-fit: contain; display: block; }
    </style>
</head>
<body>
    <main><img src="/stream" alt="MaixCAM Stream"></main>
</body>
</html>
"""


def connect_wifi():
    wifi = network.wifi.Wifi()
    while not app.need_exit():
        print("Connecting WiFi:", WIFI_SSID)
        ret = wifi.connect(
            WIFI_SSID,
            WIFI_PASSWORD,
            wait=True,
            timeout=WIFI_TIMEOUT_S,
        )

        try:
            err.check_raise(ret, "WiFi connect failed")
            ip = wifi.get_ip()
            if ip:
                print("WiFi connected, IP:", ip)
                return wifi, ip
            print("WiFi connected but no IP address")
        except Exception as e:
            print("WiFi failed:", e)

        print("Retry WiFi in 3 seconds...")
        time.sleep(3)

    return wifi, None


wifi, ip = connect_wifi()
if not ip:
    raise RuntimeError("App exit before WiFi connected")

cam = camera.Camera(CAMERA_WIDTH, CAMERA_HEIGHT)
stream = http.JpegStreamer()
stream.set_html(HTML)
stream.start()

url = "http://{}:{}".format(ip, stream.port())
print("Open in browser:")
print(url)

while not app.need_exit():
    img = cam.read()
    jpg = img.to_jpeg()
    stream.write(jpg)
