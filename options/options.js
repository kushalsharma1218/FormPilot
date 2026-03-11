document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('profile-form');
  const statusMsg = document.getElementById('save-status');

  // Load existing profile via background script
  const resp = await chrome.runtime.sendMessage({ type: 'GET_GLOBAL_PROFILE' });
  const profile = resp?.profile || {};

  // Populate form
  Object.keys(profile).forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = profile[key];
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Gather values
    const newProfile = {};
    const formData = new FormData(form);
    for (const [key, value] of formData.entries()) {
      newProfile[key] = value.trim();
    }

    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_GLOBAL_PROFILE', profile: newProfile });
      showStatus('Profile saved successfully!', 'success');
    } catch (err) {
      showStatus('Failed to save profile.', 'error');
    }
  });

  function showStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg ${type}`;
    setTimeout(() => {
      statusMsg.className = 'status-msg';
    }, 3000);
  }

  // --- Disabled Sites Logic ---
  const disabledList = document.getElementById('disabled-sites-list');

  async function renderDisabledSites() {
    const { data } = await chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' });
    const disabledSites = Object.entries(data.sites || {})
      .filter(([_, site]) => site.disabled)
      .map(([hostname, _]) => hostname);

    if (disabledSites.length === 0) {
      disabledList.innerHTML = '<p class="empty-msg">No sites are currently disabled.</p>';
      return;
    }

    disabledList.innerHTML = '';
    disabledSites.forEach(hostname => {
      const item = document.createElement('div');
      item.className = 'disabled-site-item';
      item.innerHTML = `
        <span class="site-hostname">${hostname}</span>
        <button class="btn-re-enable" data-hostname="${hostname}">Re-enable</button>
      `;
      disabledList.appendChild(item);
    });

    // Add listeners to Re-enable buttons
    disabledList.querySelectorAll('.btn-re-enable').forEach(btn => {
      btn.onclick = async () => {
        const host = btn.dataset.hostname;
        await chrome.runtime.sendMessage({ 
          type: 'SET_ENABLED', 
          hostname: host, 
          enabled: true, 
          clearDisabled: true 
        });
        renderDisabledSites();
      };
    });
  }

  renderDisabledSites();
});
