package il.co.cervinialive;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;

/** Chrome's side door into the app: notifications and the site's "where am I". */
public class DelegationService extends com.google.androidbrowserhelper.trusted.DelegationService {
    @Override
    public void onCreate() {
        super.onCreate();
        registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());
    }
}
