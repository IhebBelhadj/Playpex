package app.playpex.manager;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.animation.PathInterpolator;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity implements PullToReload.BridgeActivityHost {
    /** the launch screen never stays longer than this, ready or not */
    private static final long SPLASH_MAX_MS = 2500;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the launch screen (splash_mark.xml) until the page has drawn its own (PlaypexSplash.java)
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        PlaypexSplash.ready = false;
        long until = SystemClock.uptimeMillis() + SPLASH_MAX_MS;
        splash.setKeepOnScreenCondition(() -> !PlaypexSplash.ready && SystemClock.uptimeMillis() < until);
        splash.setOnExitAnimationListener((view) -> {
            // the black fades out as the mark grows a little: the page's splash has it in the same place
            View icon = view.getIconView();
            PathInterpolator ease = new PathInterpolator(0.4f, 0f, 0.2f, 1f);
            if (icon != null) icon.animate().scaleX(1.08f).scaleY(1.08f).setDuration(320).setInterpolator(ease).start();
            view.getView().animate().alpha(0f).setDuration(320).setInterpolator(ease).setListener(new AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(Animator animation) {
                    view.remove();
                }
            }).start();
        });
        // the launch screen's end, when the page has drawn (PlaypexSplash.java)
        registerPlugin(PlaypexSplash.class);
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
