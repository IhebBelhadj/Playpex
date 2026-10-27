package app.playpex.manager;

import android.os.Bundle;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity implements PullToReload.BridgeActivityHost {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the app's own plugin: finds Playpex servers on the network (PlaypexDiscovery.java)
        registerPlugin(PlaypexDiscovery.class);
        // the phone's connection, and a "can't reach" screen instead of Chromium's error page (PlaypexConnection.java)
        registerPlugin(PlaypexConnection.class);
        super.onCreate(savedInstanceState);
        // swipe down from the top to reload, on every page (PullToReload.java)
        PullToReload.attach(this);
        // full screen that works, and Back that goes back (AppChrome.java)
        AppChrome.attach(this, getBridge());
    }

    @Override
    public Bridge bridge() {
        return getBridge();
    }
}
