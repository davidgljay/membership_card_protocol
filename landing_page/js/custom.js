(function($) {
    "use strict"; // Start of use strict

    const path = window.location.pathname.replace(/\/$/, "") || "/";
    const links = document.querySelectorAll(".navbar-default a[href]");
    let activeLink = null;

    for (const link of links) {
        const href = link.getAttribute("href");
        if (!href || href === "#" || href.startsWith("http")) {
            continue;
        }

        const normalizedHref = href.split("#")[0].replace(/\/$/, "") || "/";
        if (normalizedHref === path) {
            activeLink = link;
            break;
        }
    }

    if (activeLink) {
        activeLink.classList.add("active");
        const navItem = activeLink.closest(".nav-item.dropdown");
        if (navItem) {
            const toggle = navItem.querySelector(".dropdown-toggle");
            if (toggle) {
                toggle.classList.add("active");
            }
        }
    }

    $('#contactForm').submit(function(e){
        e.preventDefault();
        const body = {
            form: $('#contactForm').serializeArray().reduce((obj, item) => { obj[item.name] = item.value; return obj; }, {}),
            subject: 'New Contact Submission on RLab'
        }
        $.ajax({
            url: 'https://faas-nyc1-2ef2e6cc.doserverless.co/api/v1/web/fn-8e8c4968-55c0-47b4-a2c2-0a18affc3f51/emailer/send',
            type: 'post',
            contentType: 'application/json',
            data:JSON.stringify(body),
            success:function(){
                $('#contactArea').hide()
                $('#contactThanks').show()
            }
        });
    });

    $('#newsletterForm').submit(function(e){
        e.preventDefault();
        const body = {
            form: $('#newsletterForm').serializeArray().reduce((obj, item) => { obj[item.name] = item.value; return obj; }, {}),
            subject: 'New Newsletter Submission on RLab'
        }
        $.ajax({
            url: 'https://faas-nyc1-2ef2e6cc.doserverless.co/api/v1/web/fn-8e8c4968-55c0-47b4-a2c2-0a18affc3f51/emailer/send',
            type: 'post',
            contentType: 'application/json',
            data:JSON.stringify(body),
            success:function(){
                $('#newsletterForm').hide()
                $('#newsletterThanks').show()
            }
        });
    });

})(jQuery); // End of use strict
