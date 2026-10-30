package app.playpex.manager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * ready(): the page (src/main.ts) has drawn its first screen, its own splash or the picker; the
 * system's launch screen can go (MainActivity holds it until then, 2.5 s at most).
 */
@CapacitorPlugin(name = "PlaypexSplash")
public class PlaypexSplash extends Plugin {
    static volatile boolean ready = false;

    @PluginMethod
    public void ready(PluginCall call) {
        ready = true;
        call.resolve();
    }
}
